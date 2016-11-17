import _ from 'lodash';
import Promise from 'bluebird';
import Chalk from 'chalk';
import {EventEmitter} from 'events';

import performanceNow from 'performance-now';

const FlushSchedulerKey = 'aggregate-flusher';

class DistributedCache {
    constructor(config) {
        this.instanceName = config.instanceName || 'default';
        this.logLevel = config.logLevel;

        this.redisKeyPrefix = process.env.REDIS_KEY_PREFIX;
        if (this.redisKeyPrefix) {
            this.redisKeyPrefix = `${this.redisKeyPrefix}/`;
        } else {
            this.redisKeyPrefix = '';
        }
        
        this.redisClient = config.redisClient;
        this.keyPrefix = `${this.redisKeyPrefix}${this.instanceName}:agg:`;
    }

    getKey(key) {
        return `${this.keyPrefix}${key}`;
    }

    store(key, data) {
        if (this.logLevel === 'trace') {
            console.log('(DistributedCache) Storing key: ', key, this.getKey(key));
        }

        return this.redisClient.setAsync(this.getKey(key), JSON.stringify(data))
          .then(() => data);
    }

    retrieve(key) {
        return this.redisClient.getAsync(this.getKey(key))
          .then((data) => {
              if (!_.isUndefined(data) && !_.isNull(data) && _.isString(data)) {
                  return JSON.parse(data);
              }

              return null;
          });
    }

    remove(key) {
        if (this.logLevel === 'trace') {
            console.log('(DistributedCache) Removing key: ', key, this.getKey(key));
        }

        return this.redisClient.delAsync(this.getKey(key));
    }

    keys() {
        // TODO: probably SCAN based implementation is better, but there may not be many keys too...
        return this.redisClient.keysAsync(`${this.keyPrefix}*`)
          .then(keys => keys.map(key => key.substring(this.keyPrefix.length, key.length)));
    }

    shutdown() {
        if (this.logLevel === 'trace') {
            console.log('Shutting down: DistributedCache');
        }

        return true;
    }
}

class LocalCache {
    constructor(config) {
        this.logLevel = config.logLevel;

        this.keysCount = 0;
        this.cache = {};
    }

    store(key, data) {
        if (this.logLevel === 'trace') {
            console.log('(LocalCache) Storing key: ', key, this.keysCount);
        }

        this.cache[key] = data;
        this.keysCount += 1;
        return data;
    }

    retrieve(key) {
        return this.cache[key];
    }

    remove(key) {
        this.cache[key] = undefined;
        delete this.cache[key];
        this.keysCount -= 1;

        if (this.logLevel === 'trace') {
            console.log('(LocalCache) Removed key: ', key, this.keysCount);
        }

        return true;
    }

    keys() {
        return _.keys(this.cache);
    }

    shutdown() {
        delete this.cache;
        return true;
    }
}

export default class Cache {
    constructor(config, indexer, lock) {
        this.logLevel = config.logLevel;

        let mode = 'local';
        if (config.cacheConfig) {
            const cacheConfig = config.cacheConfig;
            if (cacheConfig.type === 'redis' || config.redisClient) {
                mode = 'redis';
            }

            if (cacheConfig.flushTimeout) {
                this.flushTimeout = cacheConfig.flushTimeout;
            }
        } else {
            this.flushTimeout = 10000;
        }

        if (mode === 'redis') {
            this.instance = new DistributedCache(config);
        } else {
            this.instance = new LocalCache(config);
        }

        this.scheduleHandle = null;
        this.schedule = null;

        this.indexer = indexer;
        this.lock = lock;
        this.eventEmitter = new EventEmitter();

        this._flushing = false;

        // when we start, we schedule a flush
        this.scheduleFlush();
    }

    store(key, data) {
        // if no schedule then create a schedule
        if (!this.schedule) {
            if (this.logLevel === 'trace') {
                console.log('Store: Scheduling Flush: No Keys');
            }

            this.scheduleFlush();
        }

        if (this.logLevel === 'trace') {
            const startTime = performanceNow();
            return Promise.resolve(this.instance.store(key, data))
              .then((result) => {
                  console.log('Stored key: ', key, (performanceNow() - startTime).toFixed(3));
                  return result;
              });
        }

        return this.instance.store(key, data);
    }

    retrieve(key) {
        if (this.logLevel === 'trace') {
            const startTime = performanceNow();
            return Promise.resolve(this.instance.retrieve(key))
              .then((result) => {
                  console.log('Retrieved key: ', key, (performanceNow() - startTime).toFixed(3));
                  return result;
              });
        }

        return this.instance.retrieve(key);
    }

    remove(key) {
        if (this.logLevel === 'trace') {
            const startTime = performanceNow();
            return Promise.resolve(this.instance.remove(key))
              .then((result) => {
                  console.log('Removed key: ', key, (performanceNow() - startTime).toFixed(3));
                  return result;
              });
        }

        return this.instance.remove(key);
    }

    keys() {
        return this.instance.keys();
    }

    scheduleFlush() {
        console.log(Chalk.yellow('Scheduling Flush'));

        const operation = () => {
            if (!this.schedule) {
                this.scheduleHandle = _.delay(this.flush.bind(this), this.flushTimeout);
                this.schedule = true;

                console.log(Chalk.yellow(`Scheduled Flush: ${this.scheduleHandle}`));
            } else {
                console.log(Chalk.yellow('Schedule already exist'));
            }

            return true;
        };

        return this.lock.usingLock(operation, FlushSchedulerKey);
    }

    removeFlushSchedule() {
        console.log(Chalk.yellow('Removing Flush Schedule'));
        const operation = () => {
            if (this.schedule) {
                if (this.scheduleHandle) {
                    clearTimeout(this.scheduleHandle);
                }

                this.scheduleHandle = null;
                this.schedule = null;
            }

            return true;
        };

        return this.lock.usingLock(operation, FlushSchedulerKey, null,
          () => console.log(Chalk.yellow('Removed Flush Schedule')));
    }

    ensureFlushComplete() {
        return new Promise((resolve /*, reject*/) => {
            if (!this._flushing) {
                resolve(true);
                return true;
            }

            const _this = this;

            const checkFlushComplete = () => {
                if (!_this._flushing) {
                    return resolve(true);
                }

                _.delay(checkFlushComplete, 5000);
                return true;
            };

            _.delay(checkFlushComplete, 5000);
            return true;
        });
    }

    flush(noSchedule) {
        // flush started
        this._flushing = true;

        console.log();
        console.log(Chalk.yellow('------------------------------------------------------'));
        console.log(Chalk.yellow('Starting aggregate flush...'));

        const flushStartTime = performanceNow();

        if (this.logLevel === 'trace') {
            console.log('Flushing: AggregatorCache. NoSchedule: ', noSchedule);
        }

        return Promise.resolve(this.keys())
          .then((keys) => {
              if (!keys || _.isEmpty(keys)) {
                  if (this.logLevel === 'trace') {
                      console.log('Removing Flush Schedule: found no keys');
                  }

                  return this.removeFlushSchedule();
              }

              return Promise.map(keys, key => this.indexer.flushAggregate(key), {concurrency: 1})
                .then(() => {
                    if (!noSchedule) {
                        this.schedule = null;
                        this.scheduleHandle = null;

                        return this.scheduleFlush();
                    }

                    if (this.logLevel === 'trace') {
                        console.log('Removing Flush Schedule: noSchedule: ', noSchedule);
                    }

                    return this.removeFlushSchedule();
                });
          })
          .finally(() => {
              console.log(Chalk.yellow(`...Finished aggregate flush in: ${(performanceNow() - flushStartTime).toFixed(3)}`));
              console.log(Chalk.yellow('------------------------------------------------------'));
              this._flushing = false;
          });
    }

    shutdown() {
        // first flush, then shutdown the instance
        if (this.logLevel === 'trace') {
            console.log('Shutting down: AggregatorCache');
        }

        return Promise.resolve(this.ensureFlushComplete())
          .then(() => this.removeFlushSchedule())
          .then(() => this.flush(true))
          .then(() => this.instance.shutdown())
          .then(() => {
              console.log('Shut down: AggregatorCache');

              return true;
          });
    }
}