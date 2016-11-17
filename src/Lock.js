import Promise from 'bluebird';
import RedisLock from 'redislock';
import SemLocks from 'semlocks';
import performanceNow from 'performance-now';

const LockAcquisitionError = RedisLock.LockAcquisitionError;
const LockReleaseError = RedisLock.LockReleaseError;

class DistributedLock {
    constructor(config) {
        this.logLevel = config.logLevel;

        this.redisKeyPrefix = process.env.REDIS_KEY_PREFIX;
        if (this.redisKeyPrefix) {
            this.redisKeyPrefix = `${this.redisKeyPrefix}/`;
        } else {
            this.redisKeyPrefix = '';
        }

        this.redisClient = config.redisClient;
        const locksConfig = config.locksConfig;
        RedisLock.setDefaults({
            timeout: locksConfig.timeout || 10000,
            retries: locksConfig.retries || 1000,
            delay: locksConfig.delay || 100
        });
    }

    acquire(key) {
        key = this.redisKeyPrefix + key;

        let acquireStartTime = null;
        if (this.logLevel === 'trace') {
            acquireStartTime = performanceNow();
            console.log('(DistributedLock) Acquiring lock: ', key);
        }

        const lock = RedisLock.createLock(this.redisClient);

        return lock.acquire(key)
          .then(() => {
              if (this.logLevel === 'trace') {
                  console.log(`(DistributedLock) Acquired lock '${key}' in ${(performanceNow() - acquireStartTime).toFixed(3)}ms`);
              }

              return ({
                  key,
                  release: () => {
                      let releaseStartTime = null;
                      if (this.logLevel === 'trace') {
                          releaseStartTime = performanceNow();
                          console.log(`(DistributedLock) Releasing lock '${key}'`);
                      }

                      return lock.release()
                        .then(() => {
                            if (this.logLevel === 'trace') {
                                console.log(`(DistributedLock) Released lock '${key}' in ${(performanceNow() - releaseStartTime).toFixed(3)}ms`);
                            }

                            return true;
                        })
                        .catch(LockReleaseError, (error) => {
                            console.error(`(DistributedLock) Error in releasing lock '${key}': `, error);

                            //throw error;
                            return true;
                        });
                  }
              });
          })
          .catch(LockAcquisitionError, (error) => {
              console.error(`(DistributedLock) Error in acquiring lock '${key}': `, error);
              return Promise.reject({key, error: true, details: error});
          });
    }

    shutdown() {
        if (this.logLevel === 'trace') {
            console.log('(DistributedLock) Shutting down');
        }

        return true;
    }
}

class LocalLock {
    constructor(config) {
        this.logLevel = config.logLevel;
        this.locks = SemLocks;
    }

    acquire(key) {
        return new Promise((resolve, reject) => {
            let acquireStartTime = null;
            if (this.logLevel === 'trace') {
                acquireStartTime = performanceNow();
                console.log('(LocalLock) Acquiring Lock: ', key);
            }

            const handle = this.locks.acquire(key, {wait: 200, ttl: 200, priority: 1}, (err, release) => {
                if (err) {
                    console.error('Error in acquiring lock: ', key, err);
                    reject({key, error: true, details: err});
                    return;
                }

                if (this.logLevel === 'trace') {
                    console.log('(LocalLock) Acquired Lock: ', key, (performanceNow() - acquireStartTime).toFixed(3));
                }

                resolve({
                    key,
                    release: () => {
                        // let lockReleaseStartTime = null;

                        if (this.logLevel === 'trace') {
                            // lockReleaseStartTime = performanceNow();
                            console.log('(LocalLock) Releasing Lock: ', key);
                        }

                        return release(handle, key);
                    }
                });
            });
        });
    }

    shutdown() {
        if (this.logLevel === 'trace') {
            console.log('Shutting down: LocalLock');
        }

        delete this.locks;
        return true;
    }
}

export default class Lock {
    constructor(config) {
        this.logLevel = config.logLevel;

        let mode = 'local';
        if (config.locksConfig && config.locksConfig.type === 'redis') {
            mode = 'redis';
        }

        if (mode === 'redis') {
            this.instance = new DistributedLock(config);
        } else {
            this.instance = new LocalLock(config);
        }
    }

    acquire(key) {
        if (this.logLevel === 'trace') {
            const startTime = performanceNow();

            return Promise.resolve(this.instance.acquire(key))
              .then((result) => {
                  console.log('Acquired lock: ', key, result, (performanceNow() - startTime).toFixed(3));
                  return result;
              });
        }

        return this.instance.acquire(key);
    }

    usingLock(operation, key, lockHandle, log) {
        let finalResult = null;

        const startTime = performanceNow();

        if (lockHandle) {
            return Promise.resolve(operation(lockHandle))
              .then((result) => {
                  if (log) log((performanceNow() - startTime).toFixed(3));

                  return result;
              });
        }

        let opStartTime = null;

        let lockReleased = false;

        return Promise.resolve(this.acquire(key))

          .then((handle) => {
              lockHandle = handle;

              opStartTime = performanceNow();

              return operation(lockHandle);
          })
          .then((result) => {
              if (this.logLevel === 'trace') {
                  console.log('Operation time: ', (performanceNow() - opStartTime).toFixed(3));
              }

              finalResult = result;

              return lockHandle.release();
          })
          .then(() => {
              if (log) log((performanceNow() - startTime).toFixed(3));

              lockReleased = true;

              return finalResult;
          })
          .finally(() => {
              if (!lockReleased && lockHandle) {
                  return lockHandle.release();
              }

              return true;
          });
    }

    shutdown() {
        if (this.logLevel === 'trace') {
            console.log('Shutting down: Lock');
        }

        return this.instance.shutdown();
    }
}