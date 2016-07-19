import _ from 'lodash';
import Promise from 'bluebird';
import Chalk from 'chalk';
import performanceNow from 'performance-now';
import moment from 'moment';
import * as Request from 'humane-node-commons/lib/Request';
import buildRedisClient from 'humane-node-commons/lib/RedisClient';
import ValidationError from 'humane-node-commons/lib/ValidationError';
import InternalServiceError from 'humane-node-commons/lib/InternalServiceError';
import Lock from './Lock';
import AggregatorCache from './AggregatorCache';
import AnalysisSetting from './schemas/analysis_setting';
import * as MappingTypes from './schemas/mapping_types';
import SearchQueryMapping from './schemas/search_query_mapping';

const GET_OP = 'GET';
const ADD_OP = 'ADD';
const REMOVE_OP = 'REMOVE';
const UPDATE_OP = 'UPDATE';
const PARTIAL_UPDATE_OP = 'PARTIAL_UPDATE';

const SUCCESS_STATUS = 'SUCCESS';
const FAIL_STATUS = 'FAIL';

const NOT_FOUND_FAIL_CODE = 'NOT_FOUND';
const SKIP_FAIL_CODE = 'SKIP';

const TRACE_LOG_LEVEL = 'trace';
const DEBUG_LOG_LEVEL = 'debug';
const INFO_LOG_LEVEL = 'info';

const PUT_HTTP_METHOD = 'PUT';
const POST_HTTP_METHOD = 'POST';
const DELETE_HTTP_METHOD = 'DELETE';
const GET_HTTP_METHOD = 'GET';
const HEAD_HTTP_METHOD = 'HEAD';

const AGGREGATE_MODE = 'aggregate';

const SignalKeyRegex = /_(hourly|daily|weekly|monthly|overall)Stats/;

const SignalAggregateTimeUnitMap = {
    timestamp: {
        name: 'timestamp'
    },
    hour: {
        name: 'hour',
        part: 'hours',
        format: 'YYYYMMDDHH',
        numPeriods: 48,
        statsGroup: '_hourlyStats'
    },
    day: {
        name: 'day',
        part: 'days',
        format: 'YYYYMMDD',
        numPeriods: 90,
        statsGroup: '_dailyStats'
    },
    week: {
        name: 'week',
        part: 'weeks',
        format: 'YYYYMMWW',
        numPeriods: 12,
        statsGroup: '_weeklyStats'
    },
    month: {
        name: 'month',
        part: 'months',
        format: 'YYYYMM',
        numPeriods: 12,
        statsGroup: '_monthlyStats'
    }
};

const StatsMappingFields = {
    // Name: 'name',
    TimeInUnit: 'timeInUnit',
    LastUpdateTime: 'lastUpdateTime',
    LastNStats: 'lastNStats',
    Value: 'value'
};

// const StatsMapping = {
//     type: 'object'
//     // properties: {
//     //     name: '$Keyword',
//     //     value: '$Long',
//     //     timeInUnit: '$Long',
//     //     lastUpdateTime: '$Date',
//     //     lastNStats: {
//     //         type: 'nested',
//     //         properties: {
//     //             value: '$Long',
//     //             timeInUnit: '$Long'
//     //         }
//     //     }
//     // }
// };
//
// const OverallStatsMapping = {
//     type: 'object'
//     // properties: {
//     //     name: '$Keyword',
//     //     value: '$Long',
//     //     lastUpdateTime: '$Date'
//     // }
// };

const LangMapping = '$Keyword';

const WeightMapping = '$Double';

//
// Actual implementation is in Internal class for API class to look readable and simple.
//
class IndexerInternal {
    constructor(config) {
        this.logLevel = config.logLevel || INFO_LOG_LEVEL;
        this.instanceName = config.instanceName;

        this.request = Request.builder(_.extend({}, config.esConfig, {logLevel: this.logLevel, baseUrl: config.esConfig && config.esConfig.url || 'http://localhost:9200'}));

        if (config.redisConfig || config.redisSentinelConfig) {
            this.redisClient = buildRedisClient(_.pick(config, ['redisConfig', 'redisSentinelConfig']));
        }

        this.lock = new Lock({logLevel: this.logLevel, locksConfig: config.locksConfig, redisClient: this.redisClient});

        this.aggregatorCache = new AggregatorCache({logLevel: this.logLevel, cacheConfig: config.cacheConfig, redisClient: this.redisClient, instanceName: config.instanceName}, this, this.lock);

        const DefaultTypes = {
            searchQuery: {
                index: 'search_query',
                did_you_mean_enabled: false,
                mapping: SearchQueryMapping,
                id: (doc) => doc.key,
                weight: (doc) => doc.count,
                mode: AGGREGATE_MODE,
                aggregateBuilder: (existingDoc, newDoc) => ({key: newDoc.key, _lang: newDoc._lang, query: newDoc.query, unicodeQuery: newDoc.unicodeQuery, hasResults: newDoc.hasResults})
            }
        };

        const indices = config.indicesConfig.indices || {};

        _.forEach(DefaultTypes, (type, key) => this.enhanceType(indices, key, type));
        _.forEach(config.indicesConfig.types, (type, key) => this.enhanceType(indices, key, type));

        // TODO: validate indices config are proper
        this.indicesConfig = _.defaultsDeep(config.indicesConfig, {indices, types: DefaultTypes});
    }

    enhanceType(indices, key, type) {
        if (!type.type) {
            type.type = key;
        }

        let indexStore = null;
        if (type.index) {
            indexStore = `${_.toLower(this.instanceName)}:${_.snakeCase(type.index)}_store`;
        } else {
            indexStore = `${_.toLower(this.instanceName)}_store`;
        }

        let index = indices[indexStore];
        if (!index) {
            // we build index
            indices[indexStore] = index = {
                store: indexStore,
                analysis: AnalysisSetting
            };

            if (!_.isUndefined(type.did_you_mean_enabled)) {
                index.indexSettings = {
                    did_you_mean_enabled: type.did_you_mean_enabled
                };
            }
        }

        type.index = index.store;

        if (!type.dynamic_templates) {
            type.dynamic_templates = [
                {
                    statsGroup: {
                        match_mapping_type: 'object',
                        match: '_*Stats',
                        mapping: {
                            type: 'object'
                        }
                    }
                },
                {
                    stats: {
                        match_mapping_type: 'object',
                        path_match: '_*Stats.*',
                        mapping: {
                            type: 'object',
                            properties: {
                                // name: this.getMapping('$Keyword'),
                                value: this.getMapping('$Long'),
                                timeInUnit: this.getMapping('$Long'),
                                lastUpdateTime: this.getMapping('$Date'),
                                lastNStats: {
                                    type: 'nested',
                                    properties: {
                                        value: this.getMapping('$Long'),
                                        timeInUnit: this.getMapping('$Long')
                                    }
                                }
                            }
                        }
                    }
                }
            ];
        }

        // // ==========================================================
        // // Stats Mapping
        // //
        // // ideally these stats can reside in another DB ?
        // if (type.mapping && !type.mapping._hourlyStats) {
        //     type.mapping._hourlyStats = StatsMapping;
        // }
        //
        // if (type.mapping && !type.mapping._dailyStats) {
        //     type.mapping._dailyStats = StatsMapping;
        // }
        //
        // if (type.mapping && !type.mapping._weeklyStats) {
        //     type.mapping._weeklyStats = StatsMapping;
        // }
        //
        // if (type.mapping && !type.mapping._monthlyStats) {
        //     type.mapping._monthlyStats = StatsMapping;
        // }
        //
        // if (type.mapping && !type.mapping._overallStats) {
        //     type.mapping._overallStats = OverallStatsMapping;
        // }
        // // ==========================================================

        if (type.mapping && !type.mapping._weight) {
            type.mapping._weight = WeightMapping;
        }

        if (type.mapping && !type.mapping._lang) {
            type.mapping._lang = LangMapping;
        }

        if (!type.lang) {
            type.lang = () => 'en';
        }

        if (!type.weight) {
            type.weight = () => 1.0;
        }

        if (!type.id) {
            type.id = (doc) => doc.id;
        }
    }

    shutdown() {
        if (this.logLevel === TRACE_LOG_LEVEL) {
            console.log('Shutting down: Indexer');
        }

        return Promise.resolve(this.aggregatorCache.shutdown())
          .then(() => this.lock.shutdown())
          .then(() => {
              this.redisClient.end(true);
              return true;
          })
          .then(() => {
              if (this.logLevel === TRACE_LOG_LEVEL) {
                  console.log('Shut down: Indexer');
              }

              return true;
          });
    }

    // handleResponse(response, okStatusCodes, operation) {
    //     if (!response) {
    //         return Promise.reject('ERROR: No Response');
    //     }
    //
    //     if (_.isArray(response)) {
    //         response = response[0];
    //     }
    //
    //     if (this.logLevel === DEBUG_LOG_LEVEL
    //       || this.logLevel === TRACE_LOG_LEVEL
    //       || (response.statusCode >= 400
    //       && (!okStatusCodes || !okStatusCodes[response.statusCode])
    //       && response.request.method !== HEAD_HTTP_METHOD)) {
    //         console.log();
    //         console.log(Chalk.blue('------------------------------------------------------'));
    //         console.log(Chalk.blue.bold(`${response.request.method} ${response.request.href}`));
    //
    //         const format = response.statusCode < 400 ? Chalk.green : Chalk.red;
    //
    //         console.log(format(`Status: ${response.statusCode}, Elapsed Time: ${response.elapsedTime}`));
    //
    //         if (response.request.method !== HEAD_HTTP_METHOD) {
    //             console.log(format(JSON.stringify(response.body, null, 2)));
    //         }
    //
    //         console.log(Chalk.blue('------------------------------------------------------'));
    //         console.log();
    //     }
    //
    //     if (response.statusCode < 400 || okStatusCodes && okStatusCodes[response.statusCode]) {
    //         return _.extend({
    //             _statusCode: response.statusCode,
    //             _status: response.statusCode < 400 ? SUCCESS_STATUS : FAIL_STATUS,
    //             _elapsedTime: response.elapsedTime,
    //             _operation: operation
    //         }, response.body);
    //     }
    //
    //     throw new InternalServiceError('Internal Service Error', {
    //         _statusCode: response.statusCode, details: response.body && response.body.error || response.body
    //     });
    // }
    //
    // handleResponseArray(responses, okStatusCodes, operation) {
    //     return Promise
    //       .all(_.map(responses, response => {
    //           let promise = null;
    //           try {
    //               promise = Promise.resolve(this.handleResponse(response, okStatusCodes, operation));
    //           } catch (error) {
    //               promise = Promise.reject(error);
    //           }
    //
    //           return promise.reflect();
    //       }))
    //       .map(inspection => {
    //           if (inspection.isFulfilled()) {
    //               return inspection.value();
    //           }
    //
    //           return inspection.reason();
    //       });
    // }

    typeConfig(typeOrConfig) {
        if (!typeOrConfig) {
            throw new ValidationError('Undefined Type', {details: {code: 'UNDEFINED_TYPE'}});
        }

        if (_.isString(typeOrConfig)) {
            const typeConfig = this.indicesConfig.types[typeOrConfig];
            if (!typeConfig) {
                throw new ValidationError('Unrecognized Type', {details: {code: 'UNRECOGNIZED_TYPE', type: typeOrConfig}});
            }

            return typeConfig;
        }

        return typeOrConfig;
    }

    deleteIndex(indexKey) {
        if (!indexKey) {
            const promises = _(this.indicesConfig.indices)
              .values()
              .map((indexConfig) => this.request({method: DELETE_HTTP_METHOD, uri: `${indexConfig.store}`}))
              .value();

            return Promise.all(promises)
              .then(responses => Request.handleResponseArray(responses, {404: true}, 'DELETE_INDICES', this.logLevel));
        }

        const indexConfig = this.indicesConfig.indices[indexKey];

        return this.request({method: DELETE_HTTP_METHOD, uri: `${indexConfig.store}`})
          .then(response => Request.handleResponse(response, {404: true}, 'DELETE_INDEX', this.logLevel));
    }

    getMapping(mapping) {
        if (_.isString(mapping)) {
            return MappingTypes[mapping];
        } else if (_.isObject(mapping) && mapping.properties) {
            mapping.properties = _.mapValues(mapping.properties, property => this.getMapping(property));
            return mapping;
        }

        return mapping;
    }

    createIndex(indexKey) {
        if (!indexKey) {
            const promises = _(this.indicesConfig.indices)
              .values()
              .map((indexConfig) => {
                  const mappings = {};

                  _(this.indicesConfig.types)
                    .values()
                    .filter(type => type.index === indexConfig.store)
                    .forEach(type => {
                        mappings[type.type] = {
                            _all: {
                                enabled: false
                            },
                            dynamic_templates: type.dynamic_templates,
                            properties: _.mapValues(type.mapping, property => this.getMapping(property))
                        };
                    });

                  return this.request({
                      method: PUT_HTTP_METHOD,
                      uri: `${indexConfig.store}`,
                      body: {
                          settings: {
                              index: _.defaultsDeep(indexConfig.indexSettings, {
                                  number_of_shards: 2,
                                  did_you_mean_enabled: true,
                                  did_you_mean_index_name: `${_.toLower(this.instanceName)}:did_you_mean_store`
                              }),
                              analysis: indexConfig.analysis
                          },
                          mappings
                      }
                  });
              })
              .value();

            return Promise.all(promises)
              .then(responses => Request.handleResponseArray(responses, {404: true}, 'CREATE_INDICES'), this.logLevel);
        }

        const indexConfig = this.indicesConfig.indices[indexKey];

        const mappings = {};

        _(this.indicesConfig.types)
          .values()
          .filter(type => type.index === indexConfig.store)
          .forEach(type => {
              mappings[type.type] = {
                  _all: {
                      enabled: false
                  },
                  dynamic_templates: type.dynamic_templates,
                  properties: _.mapValues(type.mapping, property => this.getMapping(property))
              };
          });

        return this.request({
            method: PUT_HTTP_METHOD, uri: `${indexConfig.store}`, body: {
                settings: {
                    index: _.defaultsDeep(indexConfig.indexSettings, {
                        number_of_shards: 2,
                        did_you_mean_enabled: true,
                        did_you_mean_index_name: null
                    }),
                    analysis: indexConfig.analysis
                },
                mappings
            }
        })
          .then(response => Request.handleResponse(response, {404: true}, 'CREATE_INDEX'), this.logLevel);
    }

    exists(request) {
        const typeConfig = this.typeConfig(request.typeConfig || request.type);
        return this.request({method: HEAD_HTTP_METHOD, uri: `${typeConfig.index}/${typeConfig.type}/${request.id}`})
          .then(response => Request.handleResponse(response, {404: true}, 'EXISTS'), this.logLevel);
    }

    get(request) {
        let startTime = null;

        if (this.logLevel === TRACE_LOG_LEVEL) {
            startTime = performanceNow();
        }

        if (!request.id) {
            throw new ValidationError('No ID has been specified', {details: {code: 'UNDEFINED_ID'}});
        }

        const typeConfig = this.typeConfig(request.typeConfig || request.type);
        const uri = `${typeConfig.index}/${typeConfig.type}/${request.id}`;

        return this.request({method: GET_HTTP_METHOD, uri})
          .then(response => Request.handleResponse(response, {404: true}, GET_OP, this.logLevel))
          .then(response => {
              const result = !!response ? response._source : null;

              if (this.logLevel === TRACE_LOG_LEVEL) {
                  console.log('get: ', uri, (performanceNow() - startTime).toFixed(3));
              }

              return result;
          });
    }

    getFields(request, fields) {
        let startTime = null;

        const typeConfig = this.typeConfig(request.typeConfig || request.type);

        if (!request.id) {
            throw new ValidationError('No ID has been specified', {details: {code: 'UNDEFINED_ID'}});
        }

        const uri = `${typeConfig.index}/${typeConfig.type}/${request.id}`;

        if (this.logLevel === TRACE_LOG_LEVEL) {
            startTime = performanceNow();
        }

        return this.request({method: GET_HTTP_METHOD, uri, qs: {fields: _.join(fields, ',')}})
          .then(response => {
              let result = Request.handleResponse(response, {404: true}, 'OPTIMISED_GET', this.logLevel);

              result = !_.isUndefined(result) && !_.isNull(result) && _.get(result, 'found', false) ? _.get(result, 'fields', {}) : null;

              if (result) {
                  _.forEach(fields, field => {
                      if (result[field] && _.isArray(result[field])) {
                          result[field] = result[field][0];
                      }
                  });
              }

              if (this.logLevel === TRACE_LOG_LEVEL) {
                  console.log('optimisedGet: ', uri, (performanceNow() - startTime).toFixed(3));
              }

              return result;
          });
    }

    optimisedGet(request, measures) {
        const fields = [];

        _.forEach(measures, measureConfig => {
            let measureType = null;
            let measureName = null;
            let measureTypeConfig = null;

            if (_.isString(measureConfig)) {
                measureName = measureConfig;
                measureType = 'SUM';
            } else if (_.isObject(measureConfig)) {
                const config = _.first(_.toPairs(measureConfig));
                measureName = config[0];
                if (_.isString(config[1])) {
                    measureType = config[1];
                } else if (_.isFunction(config[1])) {
                    measureType = 'FUNCTION';
                } else if (!_.isFunction(config[1]) && _.isObject(config[1])) {
                    measureType = config[1].type;
                    measureTypeConfig = config[1];
                }
            }

            if (measureType === 'AVERAGE' || measureType === 'WEIGHTED_AVERAGE') {
                const countField = (measureType === 'AVERAGE') ? measureTypeConfig.count : measureTypeConfig.weight;
                fields.push(countField);
            }

            fields.push(measureName);

            return true;
        });

        return this.getFields(request, fields);
    }

    buildAggregates(request) {
        const typeConfig = this.typeConfig(request.typeConfig || request.type);
        let newDoc = request.newDoc;
        const existingDoc = request.existingDoc;
        const partial = request.partial || false;

        const aggregatorsConfig = this.indicesConfig.aggregators && this.indicesConfig.aggregators[typeConfig.type];
        if (!aggregatorsConfig) {
            return false;
        }

        if (aggregatorsConfig.filter && _.isFunction(aggregatorsConfig.filter) && !aggregatorsConfig.filter(newDoc, existingDoc, partial)) {
            newDoc = null;
        }

        if (!newDoc && !existingDoc) {
            return false;
        }

        const promises = [];

        const buildAggregatesInternal = (aggregateConfig, doc) => {
            const aggregates = [];

            if (!doc) {
                return aggregates;
            }

            let docField = doc[aggregateConfig.field];
            if (!docField) {
                return aggregates;
            }

            if (!_.isArray(docField)) {
                docField = [docField];
            }

            _.forEach(docField, fieldValue => {
                if (!fieldValue) {
                    return true;
                }

                const aggregate = aggregateConfig.aggregateBuilder(doc, fieldValue);
                const id = _.isFunction(aggregateConfig.indexType.id) && aggregateConfig.indexType.id(aggregate) || aggregate.id;

                if (id && aggregate) {
                    aggregates.push({id, aggregate});
                }

                return true;
            });

            return aggregates;
        };

        const buildMeasures = (aggregateData, aggregateConfig, aggregateOpType) => {
            const id = aggregateData.id;
            const aggregate = aggregateData.aggregate;

            const aggregateIndexConfig = aggregateConfig.indexType;
            const aggregateIndexType = aggregateIndexConfig.type;

            const key = `${aggregateIndexType}:${id}`;

            const measuresConfig = aggregateConfig.measures || aggregatorsConfig.measures;

            const operation = () =>
              Promise.resolve(this.aggregatorCache.retrieve(key))
                .then(cachedAggregateData => {
                    if (!cachedAggregateData) {
                        return this.optimisedGet({typeConfig: aggregateIndexConfig, id}, measuresConfig)
                          .then(result => (result && {doc: result, opType: UPDATE_OP, id, type: aggregateIndexType} || null));
                    }

                    return cachedAggregateData;
                })
                .then(existingAggregateData => {
                    let opType = null;
                    if (!existingAggregateData) {
                        opType = ADD_OP;
                        if (aggregateOpType === UPDATE_OP) {
                            aggregateOpType = ADD_OP;
                        } else if (aggregateOpType === REMOVE_OP) {
                            // if it does not exist what to remove ?
                            return true;
                        }
                    } else {
                        opType = existingAggregateData.opType || UPDATE_OP;
                    }

                    let existingAggregateDoc = null;
                    let newAggregateDoc = {};

                    // aggregate already exist
                    if (existingAggregateData && existingAggregateData.doc) {
                        existingAggregateDoc = existingAggregateData.doc;
                        newAggregateDoc = _.extend(newAggregateDoc, existingAggregateDoc, aggregate);
                    } else {
                        existingAggregateDoc = {};
                        newAggregateDoc = _.extend(newAggregateDoc, aggregate);
                    }

                    _.forEach(measuresConfig, measureConfig => {
                        let measureType = null;
                        let measureName = null;
                        let measureFunction = null;
                        let measureTypeConfig = null;

                        if (_.isString(measureConfig)) {
                            measureName = measureConfig;
                            measureType = 'SUM';
                        } else if (_.isObject(measureConfig)) {
                            const config = _.first(_.toPairs(measureConfig));
                            measureName = config[0];
                            if (_.isString(config[1])) {
                                measureType = config[1];
                            } else if (_.isFunction(config[1])) {
                                measureType = 'FUNCTION';
                                measureFunction = config[1];
                            } else if (_.isObject(config[1])) {
                                measureType = config[1].type;
                                measureTypeConfig = config[1];
                            }
                        }

                        if (partial && _.isUndefined(newDoc[measureName])) {
                            // we skip if new doc does not have value in case of partial update
                            return true;
                        }

                        let value = _.get(existingAggregateDoc, measureName, 0);

                        if (measureType === 'COUNT') {
                            if (aggregateOpType === ADD_OP) {
                                // simply SUM the values here
                                value += 1;
                            } else if (aggregateOpType === REMOVE_OP) {
                                // simply REDUCE the values here
                                value -= 1;
                            }
                        } else if (measureType === 'SUM') {
                            if (aggregateOpType === ADD_OP) {
                                value += _.get(newDoc, measureName, 0);
                            } else if (aggregateOpType === UPDATE_OP) {
                                value += (_.get(newDoc, measureName, 0) - _.get(existingDoc, measureName, 0));
                            } else if (aggregateOpType === REMOVE_OP) {
                                // simply REDUCE the values here
                                value -= _.get(existingDoc, measureName, 0);
                            }
                        } else if (measureType === 'AVERAGE' || measureType === 'WEIGHTED_AVERAGE') {
                            let totalCount = 0;
                            let totalValue = 0;

                            const countField = (measureType === 'AVERAGE') ? measureTypeConfig.count : measureTypeConfig.weight;

                            value = value * _.get(existingAggregateDoc, measureTypeConfig.count, 0);
                            if (aggregateOpType === ADD_OP) {
                                totalCount = _.get(existingAggregateDoc, countField, 0) + _.get(newDoc, countField, 0);
                                totalValue = value + _.get(newDoc, measureName, 0) * _.get(newDoc, countField, 0);
                            } else if (aggregateOpType === UPDATE_OP) {
                                totalCount = _.get(existingAggregateDoc, countField, 0) - _.get(existingDoc, countField, 0) + _.get(newDoc, countField, 0);
                                totalValue = value - _.get(existingDoc, measureName, 0) * _.get(existingDoc, countField, 0) + _.get(newDoc, measureName, 0) * _.get(newDoc, countField, 0);
                            } else if (aggregateOpType === REMOVE_OP) {
                                totalCount = _.get(existingAggregateDoc, countField, 0) - _.get(existingDoc, countField, 0);
                                totalValue = value - _.get(existingDoc, measureName, 0) * _.get(existingDoc, countField, 0);
                            }

                            value = _.round(totalCount > 0 ? totalValue / totalCount : 0, measureTypeConfig.round || 3);
                        } else if (measureType === 'FUNCTION') {
                            value = measureFunction(newAggregateDoc, aggregateOpType);

                            const modifier = measureTypeConfig && measureTypeConfig.modifier || 'log1p';
                            if (modifier) {
                                value = _.invoke(Math, 'log1p', value);
                            }

                            value = _.round(value, measureTypeConfig && measureTypeConfig.round || 3);
                        }

                        newAggregateDoc[measureName] = value;

                        return true;
                    });

                    return this.aggregatorCache.store(key, {doc: newAggregateDoc, existingDoc: existingAggregateDoc, opType, id, type: aggregateIndexType});
                });

            const promise = this.lock.usingLock(operation, key);

            promises.push(promise);
        };

        _(aggregatorsConfig.aggregates)
          .values()
          .forEach((aggregateConfig) => {
              const newDocAggregates = buildAggregatesInternal(aggregateConfig, newDoc);
              const existingDocAggregates = buildAggregatesInternal(aggregateConfig, existingDoc);

              const aggregatesToAdd = []; // if in newDoc, but not in existingDoc
              const aggregatesToRemove = []; // if not in newDoc, but in existingDoc
              const aggregatesToUpdate = []; // if in both newDoc and existingDoc

              _.forEach(newDocAggregates, newDocAggregate => {
                  let found = false;
                  _.forEach(existingDocAggregates, existingDocAggregate => {
                      if (newDocAggregate.id === existingDocAggregate.id) {
                          found = true;
                          return false;
                      }

                      return true;
                  });

                  if (found) {
                      aggregatesToUpdate.push(newDocAggregate);
                  } else {
                      aggregatesToAdd.push(newDocAggregate);
                  }
              });

              _.forEach(existingDocAggregates, existingDocAggregate => {
                  let found = false;
                  _.forEach(newDocAggregates, newDocAggregate => {
                      if (newDocAggregate.id === existingDocAggregate.id) {
                          found = true;
                          return false;
                      }

                      return true;
                  });

                  if (!found) {
                      // for partial case if there is no doc aggregate, still update aggregate for existing doc aggregate
                      if (partial && (!newDocAggregates || newDocAggregates.length === 0)) {
                          aggregatesToUpdate.push(existingDocAggregate);
                      } else if (!partial) {
                          aggregatesToRemove.push(existingDocAggregate);
                      }
                  }
              });

              _.forEach(aggregatesToAdd, aggregateData => buildMeasures(aggregateData, aggregateConfig, ADD_OP));
              _.forEach(aggregatesToRemove, aggregateData => buildMeasures(aggregateData, aggregateConfig, REMOVE_OP));
              _.forEach(aggregatesToUpdate, aggregateData => buildMeasures(aggregateData, aggregateConfig, UPDATE_OP));

              // aggregate signals in newDocAggregates
              if (request.signal) {
                  _.forEach(newDocAggregates, aggregateData => {
                      const id = aggregateData.id;
                      const aggregate = aggregateData.aggregate;

                      const aggregateIndexConfig = aggregateConfig.indexType;
                      const aggregateIndexType = aggregateIndexConfig.type;

                      const key = `${aggregateIndexType}:${id}`;

                      // const measuresConfig = aggregateConfig.measures || aggregatorsConfig.measures;

                      const operation = () =>
                        Promise.resolve(this.aggregatorCache.retrieve(key))
                          .then(cachedAggregateData => {
                              if (!cachedAggregateData) {
                                  return this.getFields({typeConfig: aggregateIndexConfig, id}, ['_dailyStats', '_weeklyStats', '_monthlyStats', '_overallStats'])
                                    .then(result => (result && {doc: result, UPDATE_OP, id, type: aggregateIndexType} || null));
                              }

                              return cachedAggregateData;
                          })
                          .then(existingAggregateData => {
                              if (!existingAggregateData || !existingAggregateData.doc) {
                                  // it's actually an error
                                  console.error('No existing aggregate data for key: ', key);
                                  return true;
                              }

                              const existingAggregateDoc = existingAggregateData.doc;
                              const newAggregateDoc = _.extend({}, existingAggregateDoc, aggregate);

                              // aggregate signal here
                              this._aggregateSignals(newAggregateDoc, request.signal);

                              return this.aggregatorCache.store(key, {doc: newAggregateDoc, existingDoc: existingAggregateDoc, UPDATE_OP, id, type: aggregateIndexType});
                          });

                      const promise = this.lock.usingLock(operation, key);

                      promises.push(promise);
                  });
              }
          });

        return Promise.all(promises).then((responses) => _.every(responses, response => !!response));
    }

    flushAggregate(key) {
        console.log(Chalk.yellow(`Flushing Key: ${key}`));

        const operation = (lockHandle) =>
          Promise.resolve(this.aggregatorCache.retrieve(key))
            .then(cachedAggregate => {
                if (!cachedAggregate) {
                    return null;
                }

                const {doc, type, id} = cachedAggregate;

                if (cachedAggregate.opType !== ADD_OP) {
                    return this.update({type, id, doc, existingDoc: cachedAggregate.existingDoc, lockHandle});
                }

                return this.add({type, doc, id, lockHandle});
            })
            .then(() => this.aggregatorCache.remove(key))
            .catch(error => {
                console.error(`>>> Error in flushing key: ${key}`, error, error.stack);
                return false;
            });

        return this.lock.usingLock(operation, key, null, timeTaken => console.log(Chalk.yellow(`Flushed Key: ${key} in ${timeTaken}ms`)));
    }

    add(request) {
        const operationType = ADD_OP;
        const typeConfig = this.typeConfig(request.typeConfig || request.type);
        const transform = typeConfig.transform;

        let doc = request.doc;
        if (transform && _.isFunction(transform)) {
            doc = transform(doc) || doc;
        }

        const id = request.id || typeConfig.id(doc);

        if (!id) {
            throw new ValidationError('No ID has been specified or can be calculated', {details: {code: 'UNDEFINED_ID'}});
        }

        if (request.filter && _.isFunction(request.filter) && !request.filter(doc)) {
            return {_id: id, _type: typeConfig.type, _index: typeConfig.index, _statusCode: 404, _status: FAIL_STATUS, _failCode: SKIP_FAIL_CODE, _operation: operationType};
        }

        if (typeConfig.filter && _.isFunction(typeConfig.filter) && !typeConfig.filter(doc)) {
            return {_id: id, _type: typeConfig.type, _index: typeConfig.index, _statusCode: 404, _status: FAIL_STATUS, _failCode: SKIP_FAIL_CODE, _operation: operationType};
        }

        if (typeConfig.weight && _.isFunction(typeConfig.weight)) {
            doc._weight = _.round(Math.log1p(typeConfig.weight(doc)), 3);
        }

        if (typeConfig.lang && _.isFunction(typeConfig.lang)) {
            doc._lang = typeConfig.lang(doc);
        }

        let result = null;

        const operation = () =>
          Promise.resolve(_.isUndefined(request.existingDoc) ? this.get({typeConfig, id}) : request.existingDoc)
            .then(existingDoc => {
                if (existingDoc) {
                    return {_id: id, _type: typeConfig.type, _index: typeConfig.index, _statusCode: 404, _status: FAIL_STATUS, _failCode: 'EXISTS_ALREADY', _operation: operationType};
                }

                return this.request({method: PUT_HTTP_METHOD, uri: `${typeConfig.index}/${typeConfig.type}/${id}`, body: doc})
                  .then(response => Request.handleResponse(response, {404: true}, operationType, this.logLevel))
                  .then(response => {
                      result = response;

                      return this.buildAggregates({typeConfig, newDoc: doc});
                  })
                  .then(() => _.pick(result, ['_id', '_type', '_index', '_version', '_statusCode', '_status', '_operation']));
            });

        return this.lock.usingLock(operation, `${typeConfig.type}:${id}`, request.lockHandle, timeTaken => console.log(Chalk.blue(`Added ${typeConfig.type} #${id} in ${timeTaken}ms`)));
    }

    remove(request) {
        const operationType = REMOVE_OP;
        const typeConfig = this.typeConfig(request.typeConfig || request.type);

        const id = request.id;

        if (!id) {
            throw new ValidationError('No ID has been specified or can be calculated', {details: {code: 'UNDEFINED_ID'}});
        }

        let result = null;

        const operation = () =>
          Promise.resolve(request.doc || this.get({typeConfig, id}))
            .then(existingDoc => {
                if (!existingDoc) {
                    return {_id: id, _type: typeConfig.type, _index: typeConfig.index, _statusCode: 404, _status: FAIL_STATUS, _failCode: NOT_FOUND_FAIL_CODE, _operation: operationType};
                }

                return this.request({method: DELETE_HTTP_METHOD, uri: `${typeConfig.index}/${typeConfig.type}/${id}`})
                  .then(response => Request.handleResponse(response, {404: true}, operationType, this.logLevel))
                  .then(response => {
                      result = response;

                      return this.buildAggregates({typeConfig, existingDoc, partial: request.partial});
                  })
                  .then(() => _.pick(result, ['_id', '_type', '_index', '_version', 'found', '_statusCode', '_status', '_operation']));
            });

        return this.lock.usingLock(operation, `${typeConfig.type}:${id}`, request.lockHandle, timeTaken => console.log(Chalk.red(`Removed ${typeConfig.type} #${id} in ${timeTaken}ms`)));
    }

    update(request) {
        const operationType = request.partial ? PARTIAL_UPDATE_OP : UPDATE_OP;
        const typeConfig = this.typeConfig(request.typeConfig || request.type);
        const transform = typeConfig.transform;

        // TODO: transform may not well behave for partial document
        // TODO: who defines undefined state for transform
        let newDoc = request.doc;
        if (transform && _.isFunction(transform) && !request.partial) {
            newDoc = transform(newDoc) || newDoc;
        }

        const id = request.id || typeConfig.id(newDoc);

        if (!id) {
            throw new ValidationError('No ID has been specified or can be calculated', {details: {code: 'UNDEFINED_ID'}});
        }

        let result = null;

        const operation = () =>
          Promise.resolve(request.existingDoc || this.get({typeConfig, id}))
            .then(existingDoc => {
                if (!existingDoc) {
                    return {
                        _id: id,
                        _type: typeConfig.type,
                        _index: typeConfig.index,
                        _statusCode: 404,
                        _status: FAIL_STATUS,
                        _failCode: NOT_FOUND_FAIL_CODE,
                        _operation: operationType
                    };
                }

                // the merge strategy in case of partial v/s full
                // when it is partial only the values defined in newDoc gets merged - primitive values v/s object values v/s array values... it's all or none
                // in case of full update, for any value not defined in newDoc - need to be explicitly marked null
                if (!request.partial) {
                    _.forOwn(existingDoc, (value, key) => {
                        if (!SignalKeyRegex.test(key) && _.isUndefined(newDoc[key])) {
                            newDoc[key] = null;
                        }
                    });
                }

                const mergedDoc = _.defaults({}, newDoc, existingDoc);
                if (typeConfig.weight && _.isFunction(typeConfig.weight)) {
                    newDoc._weight = _.round(Math.log1p(typeConfig.weight(mergedDoc)), 3);
                }

                if (typeConfig.lang && _.isFunction(typeConfig.lang)) {
                    newDoc._lang = typeConfig.lang(mergedDoc);
                }

                if (request.filter && _.isFunction(request.filter) && !request.filter(newDoc, existingDoc, request.partial)) {
                    // if it is filtered by type then remove
                    if (typeConfig.filter && _.isFunction(typeConfig.filter) && !typeConfig.filter(newDoc, existingDoc, request.partial)) {
                        return this.remove({typeConfig, id, doc: existingDoc, lockHandle: request.lockHandle, partial: request.partial});
                    }

                    // more of a partial update
                    return {
                        _id: id,
                        _type: typeConfig.type,
                        _index: typeConfig.index,
                        _statusCode: 404,
                        _status: FAIL_STATUS,
                        _failCode: SKIP_FAIL_CODE,
                        _operation: operationType
                    };
                }

                if (typeConfig.filter && _.isFunction(typeConfig.filter) && !typeConfig.filter(newDoc, existingDoc, request.partial)) {
                    return this.remove({typeConfig, id, doc: existingDoc, lockHandle: request.lockHandle, partial: request.partial});
                }

                return this.request({method: POST_HTTP_METHOD, uri: `${typeConfig.index}/${typeConfig.type}/${id}/_update`, body: {doc: newDoc}})
                  .then(response => Request.handleResponse(response, {404: true}, operationType, this.logLevel))
                  .then(response => {
                      result = response;

                      return this.buildAggregates({typeConfig, newDoc, existingDoc, partial: request.partial, signal: request.signal});
                  })
                  .then(() => _.pick(result, ['_id', '_type', '_index', '_version', '_statusCode', '_status', '_operation']));
            });

        return this.lock.usingLock(operation, `${typeConfig.type}:${id}`, request.lockHandle, timeTaken => console.log(Chalk.green(`Updated ${typeConfig.type} #${id} in ${timeTaken}ms`)));
    }

    _dayToMonth(valueOrMoment) {
        if (!moment.isMoment(valueOrMoment)) {
            valueOrMoment = moment(valueOrMoment, SignalAggregateTimeUnitMap.day.format);
        }

        return Number.parseInt(valueOrMoment.format(SignalAggregateTimeUnitMap.month.format), 10);
    }

    _dayToWeek(valueOrMoment) {
        if (!moment.isMoment(valueOrMoment)) {
            valueOrMoment = moment(valueOrMoment, SignalAggregateTimeUnitMap.day.format);
        }

        return Number.parseInt(valueOrMoment.format(SignalAggregateTimeUnitMap.week.format), 10);
    }

    _hourToDay(valueOrMoment) {
        if (!moment.isMoment(valueOrMoment)) {
            valueOrMoment = moment(valueOrMoment, SignalAggregateTimeUnitMap.hour.format);
        }

        return Number.parseInt(valueOrMoment.format(SignalAggregateTimeUnitMap.day.format), 10);
    }

    _timestampToHour(valueOrMoment) {
        if (!moment.isMoment(valueOrMoment)) {
            valueOrMoment = moment(valueOrMoment);
        }

        return Number.parseInt(valueOrMoment.format(SignalAggregateTimeUnitMap.hour.format), 10);
    }

    _lastNPeriodStart(inputPeriod, periodUnit, inputPeriodAsMoment) {
        if (!inputPeriodAsMoment) {
            inputPeriodAsMoment = moment(inputPeriod, periodUnit.format);
        } else {
            // clone
            inputPeriodAsMoment = moment(inputPeriodAsMoment);
        }

        const modifiedMoment = inputPeriodAsMoment.subtract(periodUnit.numPeriods, periodUnit.part);

        return Number.parseInt(modifiedMoment.format(periodUnit.format), 10);
    }

    _aggregatePeriod(stats, inputPeriod, periodUnit, signalName, signalValue = 1, inputPeriodAsMoment, updateTime) {
        if (!updateTime) {
            updateTime = Date.now();
        }

        const statsGroup = periodUnit.statsGroup;

        if (!inputPeriodAsMoment) {
            inputPeriodAsMoment = moment(inputPeriod, periodUnit.format);
        }

        const fieldKey = (field) => `${statsGroup}.${signalName}.${field}`;

        // there may not be any stat too in oldDoc
        const oldPeriod = _.get(stats, fieldKey(StatsMappingFields.TimeInUnit), 0);
        const oldLastNStats = _.get(stats, fieldKey(StatsMappingFields.LastNStats));
        const oldValue = _.get(stats, fieldKey(StatsMappingFields.Value), 0);

        let lastNStats = null;
        if (oldLastNStats && !_.isEmpty(oldLastNStats)) {
            lastNStats = oldLastNStats;
        } else {
            lastNStats = [];
        }

        const setInLastNStats = (timeInUnit, value, add) => {
            let found = false;

            _.forEach(lastNStats, stat => {
                if (stat.timeInUnit === timeInUnit) {
                    if (add) {
                        stat.value = (stat.value || 0) + value;
                    } else {
                        stat.value = value;
                    }
                    found = true;
                    return false;
                }

                return true;
            });

            if (!found) {
                lastNStats.push({timeInUnit, value});
            }
        };

        const sortedLastNStats = () => _.sortBy(lastNStats, StatsMappingFields.TimeInUnit);

        if (oldPeriod) {
            const lastNPeriodStart = this._lastNPeriodStart(inputPeriod, periodUnit, inputPeriodAsMoment);
            const oldNPeriodStart = this._lastNPeriodStart(oldPeriod, periodUnit);

            if (oldPeriod === inputPeriod) {
                // periods are same
                // no need to update lastNStats
                const newSignalValue = oldValue + signalValue;

                _.set(stats, fieldKey(StatsMappingFields.LastUpdateTime), updateTime);
                _.set(stats, fieldKey(StatsMappingFields.Value), newSignalValue);

                setInLastNStats(inputPeriod, newSignalValue);
                _.set(stats, fieldKey(StatsMappingFields.LastNStats), sortedLastNStats());
            } else if (oldPeriod < lastNPeriodStart) {
                // old period falls below the range of input period and its previous n periods
                // discard all lastNStats
                // set the value as inputPeriod
                _.set(stats, fieldKey(StatsMappingFields.TimeInUnit), inputPeriod);
                _.set(stats, fieldKey(StatsMappingFields.LastUpdateTime), updateTime);
                _.set(stats, fieldKey(StatsMappingFields.Value), signalValue);

                setInLastNStats(inputPeriod, signalValue);
                _.set(stats, fieldKey(StatsMappingFields.LastNStats), sortedLastNStats());
            } else if (oldPeriod >= lastNPeriodStart && oldPeriod < inputPeriod) {
                // oldPeriod fall in range of input period, and previous n periods
                // set old period value in lastNStats
                // discard all values from lastNStats that are older than previous n periods
                // set input period as current
                if (!_.isEmpty(lastNStats)) {
                    lastNStats = _.filter(lastNStats, stat => stat.timeInUnit < lastNPeriodStart);
                }

                lastNStats.push({timeInUnit: oldPeriod, value: oldValue});

                _.set(stats, fieldKey(StatsMappingFields.TimeInUnit), inputPeriod);
                _.set(stats, fieldKey(StatsMappingFields.LastUpdateTime), updateTime);
                _.set(stats, fieldKey(StatsMappingFields.Value), signalValue);

                setInLastNStats(inputPeriod, signalValue);
                _.set(stats, fieldKey(StatsMappingFields.LastNStats), sortedLastNStats());
            } else if (inputPeriod < oldPeriod && inputPeriod >= oldNPeriodStart) {
                // input period fall in range of old period and its previous n periods
                // just set the input period value in the lastNStats
                setInLastNStats(inputPeriod, signalValue, true);
                _.set(stats, fieldKey(StatsMappingFields.LastNStats), sortedLastNStats());
            } else if (inputPeriod < oldNPeriodStart) {
                // we simply ignore...
            }
        } else {
            // there is no previous value so simply update the current value
            // _.set(stats, fieldKey(StatsMappingFields.Name), signalName);
            _.set(stats, fieldKey(StatsMappingFields.TimeInUnit), inputPeriod);
            _.set(stats, fieldKey(StatsMappingFields.LastUpdateTime), updateTime);
            _.set(stats, fieldKey(StatsMappingFields.Value), signalValue);

            setInLastNStats(inputPeriod, signalValue);
            _.set(stats, fieldKey(StatsMappingFields.LastNStats), sortedLastNStats());
        }
    }

    _aggregateOverallSignal(stats, signalName, signalValue = 1, updateTime) {
        const fieldKey = (field) => `_overallStats.${signalName}.${field}`;

        _.set(stats, fieldKey(StatsMappingFields.LastUpdateTime), updateTime);
        _.set(stats, fieldKey(StatsMappingFields.Value), signalValue + _.get(stats, fieldKey(StatsMappingFields.Value), 0));
    }

    _aggregateMonthlySignal(stats, signal, timeAsMoment, updateTime) {
        this._aggregatePeriod(stats, signal.timeInUnit, SignalAggregateTimeUnitMap.month, signal.name, signal.value, timeAsMoment, updateTime);
    }

    _aggregateWeeklySignal(stats, signal, timeAsMoment, updateTime) {
        this._aggregatePeriod(stats, signal.timeInUnit, SignalAggregateTimeUnitMap.week, signal.name, signal.value, timeAsMoment, updateTime);
    }

    _aggregateDailySignal(stats, signal, timeAsMoment, updateTime) {
        if (!timeAsMoment) {
            timeAsMoment = moment(signal.timeInUnit, SignalAggregateTimeUnitMap.day.format);
        }

        this._aggregatePeriod(stats, signal.timeInUnit, SignalAggregateTimeUnitMap.day, signal.name, signal.value, timeAsMoment, updateTime);

        // we identify week from signal
        // create new signal and invoke _aggregateWeeklySignal
        const week = this._dayToWeek(timeAsMoment);
        this._aggregateWeeklySignal(stats, _.defaultsDeep({timeUnit: SignalAggregateTimeUnitMap.week.name, timeInUnit: week}, signal), timeAsMoment, updateTime);

        // we identify month from signal
        // create new signal and invoke _aggregateMonthlySignal
        const month = this._dayToMonth(timeAsMoment);
        this._aggregateMonthlySignal(stats, _.defaultsDeep({timeUnit: SignalAggregateTimeUnitMap.month.name, timeInUnit: month}, signal), timeAsMoment, updateTime);
    }

    _aggregateHourlySignal(stats, signal, timeAsMoment, updateTime) {
        if (!timeAsMoment) {
            timeAsMoment = moment(signal.timeInUnit, SignalAggregateTimeUnitMap.hour.format);
        }

        this._aggregatePeriod(stats, signal.timeInUnit, SignalAggregateTimeUnitMap.hour, signal.name, signal.value, timeAsMoment, updateTime);

        const day = this._hourToDay(timeAsMoment);
        this._aggregateDailySignal(stats, _.defaultsDeep({timeUnit: SignalAggregateTimeUnitMap.day.name, timeInUnit: day}, signal), timeAsMoment, updateTime);
    }

    _aggregateInstanceSignal(stats, signal, updateTime) {
        // we identify day from signal
        // create new signal and invoke _aggregateHourlySignal
        const timeAsMoment = moment(signal.timeInUnit);
        const hour = this._timestampToHour(timeAsMoment);

        this._aggregateHourlySignal(stats, _.defaultsDeep({timeUnit: SignalAggregateTimeUnitMap.hour.name, timeInUnit: hour}, signal), timeAsMoment, updateTime);
    }

    _aggregateSignal(stats, signal, updateTime) {
        if (!signal.timeUnit || signal.timeUnit === SignalAggregateTimeUnitMap.timestamp.name) {
            this._aggregateInstanceSignal(stats, signal, updateTime);
        } else if (signal.timeUnit === SignalAggregateTimeUnitMap.hour.name) {
            this._aggregateHourlySignal(stats, signal, updateTime);
        } else if (signal.timeUnit === SignalAggregateTimeUnitMap.day.name) {
            this._aggregateDailySignal(stats, signal, updateTime);
        } else if (signal.timeUnit === SignalAggregateTimeUnitMap.week.name) {
            this._aggregateWeeklySignal(stats, signal, updateTime);
        } else if (signal.timeUnit === SignalAggregateTimeUnitMap.month.name) {
            this._aggregateMonthlySignal(stats, signal, updateTime);
        }

        // aggregate overall stats
        this._aggregateOverallSignal(stats, signal.name, signal.value, updateTime);
    }

    // now we support only summing up of values
    // probably later we may support average, weighted average too... this is useful for ratings.
    _aggregateSignals(newDoc, signalOrArray) {
        const updateTime = Date.now();

        // const stats = _(newDoc)
        //   .pick('_hourlyStats', '_dailyStats', '_weeklyStats', '_monthlyStats', '_overallStats')
        //   // .mapValues(value => _.keyBy(value, 'name'))
        //   .value();

        const stats = newDoc;

        if (_.isArray(signalOrArray)) {
            _.forEach(signalOrArray, signal => this._aggregateSignal(stats, signal, updateTime));
        } else {
            this._aggregateSignal(stats, signalOrArray, updateTime);
        }

        // _.forOwn(stats, (statGroup, statGroupKey) => {
        //     newDoc[statGroupKey] = _.values(statGroup);
        //
        //     return true;
        // });
    }

    upsert(request) {
        const typeConfig = this.typeConfig(request.typeConfig || request.type);
        const doc = request.doc;

        const mode = typeConfig.mode;

        const id = typeConfig.id(doc);

        if (!id) {
            throw new ValidationError('No ID has been specified or can be calculated', {details: {code: 'UNDEFINED_ID'}});
        }

        const key = `${typeConfig.type}:${id}`;

        // for now upsert operation is the only supported for aggregate mode
        if (mode && mode === AGGREGATE_MODE) {
            const aggregateOperation = () => {
                let startTime = null;

                if (this.logLevel === TRACE_LOG_LEVEL) {
                    startTime = performanceNow();
                }

                return Promise.resolve(this.aggregatorCache.retrieve(key))
                  .then(cachedAggregateData => {
                      if (!cachedAggregateData) {
                          return this.optimisedGet({typeConfig, id}, typeConfig.measures)
                            .then(result => (result && {doc: result, opType: UPDATE_OP, id, type: typeConfig.type} || null));
                      }

                      return cachedAggregateData;
                  })
                  .then(existingAggregateData => {
                      const aggregateOpType = ADD_OP;

                      const aggregateDoc = typeConfig.aggregateBuilder(existingAggregateData && existingAggregateData.doc, doc);

                      const measuresConfig = typeConfig.measures;

                      let existingAggregateDoc = null;
                      let newAggregateDoc = {};

                      // aggregate already exist
                      if (existingAggregateData && existingAggregateData.doc) {
                          existingAggregateDoc = existingAggregateData.doc;
                          newAggregateDoc = _.extend(newAggregateDoc, existingAggregateDoc, aggregateDoc);
                      } else {
                          existingAggregateDoc = {};
                          newAggregateDoc = _.extend(newAggregateDoc, aggregateDoc);
                      }

                      // aggregating into _dailyStats, _weeklyStats, _monthlyStats, _overallStats
                      // signals will come separate in request
                      // signals: [{name: 'signal', timeUnit: '', timeInUnit: '', value: }]
                      if (request.signal) {
                          this._aggregateSignals(newAggregateDoc, request.signal);
                      }

                      if (measuresConfig) {
                          // aggregating as per measuresConfig
                          _.forEach(measuresConfig, measureConfig => {
                              let measureType = null;
                              let measureName = null;
                              let measureFunction = null;
                              let measureTypeConfig = null;

                              if (_.isString(measureConfig)) {
                                  measureName = measureConfig;
                                  measureType = 'SUM';
                              } else if (_.isObject(measureConfig)) {
                                  const config = _.first(_.toPairs(measureConfig));
                                  measureName = config[0];
                                  if (_.isString(config[1])) {
                                      measureType = config[1];
                                  } else if (_.isFunction(config[1])) {
                                      measureType = 'FUNCTION';
                                      measureFunction = config[1];
                                  } else if (_.isObject(config[1])) {
                                      measureType = config[1].type;
                                      measureTypeConfig = config[1];
                                  }
                              }

                              if (request.partial && _.isUndefined(doc[measureName])) {
                                  // we skip if new doc does not have value in case of partial update
                                  return true;
                              }

                              let value = _.get(existingAggregateDoc, measureName, 0);

                              if (measureType === 'COUNT') {
                                  value += 1;
                              } else if (measureType === 'SUM') {
                                  value += _.get(doc, measureName, 0);
                              } else if (measureType === 'AVERAGE' || measureType === 'WEIGHTED_AVERAGE') {
                                  const countField = (measureType === 'AVERAGE') ? measureTypeConfig.count : measureTypeConfig.weight;

                                  const totalValue = value * _.get(existingAggregateDoc, countField, 0) + _.get(doc, measureName, 0) * _.get(doc, countField, 0);
                                  const totalCount = _.get(existingAggregateDoc, countField, 0) + _.get(doc, countField, 0);

                                  value = _.round(totalCount > 0 ? totalValue / totalCount : 0, measureTypeConfig.round || 3);
                              } else if (measureType === 'FUNCTION') {
                                  value = measureFunction(newAggregateDoc, aggregateOpType);

                                  const modifier = measureTypeConfig && measureTypeConfig.modifier || 'log1p';
                                  if (modifier) {
                                      value = _.invoke(Math, 'log1p', value);
                                  }

                                  value = _.round(value, measureTypeConfig && measureTypeConfig.round || 3);
                              }

                              newAggregateDoc[measureName] = value;

                              return true;
                          });
                      }

                      if (this.logLevel === TRACE_LOG_LEVEL) {
                          console.log('Aggregation time: ', key, (performanceNow() - startTime).toFixed(3));
                      }

                      return this.aggregatorCache.store(key, {doc: newAggregateDoc, existingDoc: existingAggregateDoc, opType: existingAggregateDoc.opType || ADD_OP, id, type: typeConfig.type});
                  })
                  .then(() => {
                      if (this.logLevel === TRACE_LOG_LEVEL) {
                          console.log('Finished aggregate upsert: ', key, (performanceNow() - startTime).toFixed(3));
                      }

                      return {_statusCode: 200, _status: SUCCESS_STATUS, _id: id, _type: typeConfig.type, _index: typeConfig.index, _operation: 'LAZY_AGGREGATE'};
                  });
            };

            return this.aggregatorCache.ensureFlushComplete()
              .then(() =>
                this.lock.usingLock(aggregateOperation, key, null, (timeTaken) => console.log(Chalk.magenta(`Upserted ${typeConfig.type} #${id} in ${timeTaken}ms`))));
        }

        const operation = (lockHandle) =>
          Promise.resolve(this.get({typeConfig, id}))
            .then(existingDoc => {
                if (existingDoc) {
                    return this.update({typeConfig, id, doc, existingDoc, lockHandle});
                }

                return this.add({typeConfig, doc, existingDoc: null, id, lockHandle});
            });

        return this.lock.usingLock(operation, key, null, (timeTaken) => console.log(Chalk.magenta(`Upserted ${typeConfig.type} #${id} in ${timeTaken}ms`)));
    }

    partialUpdate(request) {
        return this.update(_.extend(request, {partial: true}));
    }

    // TODO: signal needs to be defined only if a different type of aggregation is needed, than count / sum
    // defineSignal(request) {}

    // TODO: later on this aggregation shall happen using redis cache and at a frequency, not immediate
    // let signals that require replace value come through different APIs
    // this method is good when client would integrate individual signals
    // and possibly along with user context
    // else he shall be good with using update
    // /signal/type/id or /signal request.type, request.id, request.signal, request.user
    addSignal(request) {
        // const signalSchema = {
        //     type: '',
        //     id: '',
        //     signal: [{
        //         name: 'name',
        //         timeUnit: 'timestamp', // timestamp, day, week, month
        //         timeInUnit: '20160504', // YYYYMMDD value
        //         value: 1
        //     }],
        //     user: {
        //         id: '',
        //         aid: '',
        //         iid: '',
        //         cid: '',
        //         hid: '',
        //         agent: ''
        //     }
        // };

        const typeConfig = this.typeConfig(request.type);
        const id = request.id;

        if (!id) {
            throw new ValidationError('No ID has been specified', {details: {code: 'UNDEFINED_ID'}});
        }

        // TODO: validate as per signal schema
        // TODO: if user is defined, then validate as per user schema
        if (!request.signal) {
            throw new ValidationError('No Signal has been specified', {details: {code: 'UNDEFINED_SIGNAL'}});
        }

        // TODO: retrieval of the document could be from cache
        // TODO: we retrieve only signals
        const operation = (lockHandle) =>
          Promise.resolve(this.get({typeConfig, id}))
            .then(existingDoc => {
                if (!existingDoc) {
                    throw new ValidationError(`SIGNAL: No document found for type=[${request.type}] and id=[${id}]`, {details: {code: 'NOT_EXISTS'}});
                }

                const newDoc = _.extend({}, existingDoc);

                // aggregate signals here
                this._aggregateSignals(newDoc, request.signal);

                // TODO: save here could be to the cache
                return this.partialUpdate({typeConfig, id, doc: newDoc, existingDoc, lockHandle, signal: request.signal});
            });

        const key = `${typeConfig.type}:${id}`;

        return this.lock.usingLock(operation, key, null, (timeTaken) => console.log(Chalk.magenta(`Added Signal for ${typeConfig.type} #${id} in ${timeTaken}ms`)));
    }

    // createLookupDictionary(dictionaryName) {
    //     // creates a lucene index for the instanceName:lookup:dictionaryName
    //     // schema is pretty much same -- key and any properties
    // }
    //
    // deleteLookupDictionary(dictionaryName) {
    //     // deletes a lucene index for the instanceName:lookup:dictionaryName
    // }
    //
    // addLookup(dictionaryName, key, value) {
    //
    // }
    //
    // deleteLookup(dictionaryName, key) {
    //
    // }
    //
    // updateLookup(dictionaryName, key, value, partial) {
    //
    // }
    //
    // upsertLookup(dictionaryName, key, value) {
    //
    // }
    //
    // createSynonymDictionary(dictionaryName) {
    //
    // }
    //
    // deleteSynonymDictionary(dictionaryName) {
    //
    // }
    //
    // addSynonym(dictionaryName, ...value) {
    //     // all value shall belong to same synonym set
    // }
    //
    // deleteSynonym(dictionaryName, ...value) {
    //     // all value shall belong to same synonym set
    //     // if it is the last value, then delete the synonym set too
    // }
    //
    // updateSynonym(dictionaryName, oldValue, newValue) {
    //     // update old value of synonym to new value
    // }
}

//
// Exposed API
//
export default class Indexer {
    constructor(indicesConfig) {
        this.internal = new IndexerInternal(indicesConfig);
    }

    errorWrap(promise) {
        return Promise.resolve(promise)
          .catch(error => {
              console.error('>>> Error', error, error.stack);
              if (error && (error._errorCode === 'VALIDATION_ERROR' || error._errorCode === 'INTERNAL_SERVICE_ERROR')) {
                  // rethrow same error
                  throw error;
              }

              throw new InternalServiceError('Internal Service Error', {details: error && error.cause || error, stack: error && error.stack});
          });
    }

    upsert(headers, request) {
        return this.errorWrap(this.internal.upsert(request));
    }

    update(headers, request) {
        return this.errorWrap(this.internal.update(request));
    }

    partialUpdate(headers, request) {
        return this.errorWrap(this.internal.partialUpdate(request));
    }

    addSignal(headers, request) {
        return this.errorWrap(this.internal.addSignal(request));
    }

    remove(headers, request) {
        return this.errorWrap(this.internal.remove(request));
    }

    add(headers, request) {
        return this.errorWrap(this.internal.add(request));
    }

    createIndex(indexKey) {
        return this.errorWrap(this.internal.createIndex(indexKey));
    }

    deleteIndex(indexKey) {
        return this.errorWrap(this.internal.deleteIndex(indexKey));
    }

    shutdown() {
        return this.internal.shutdown();
    }

    registry() {
        return {
            'signal/:type:/:id': {handler: this.addSignal, method: 'put'},
            signal: {handler: this.addSignal, method: 'put'},
            upsert: {handler: this.upsert},
            update: {handler: this.update},
            partialUpdate: {handler: this.partialUpdate},
            remove: {handler: this.remove},
            add: {handler: this.add},
            ':type': [
                {handler: this.upsert},
                {handler: this.add, method: 'put'}
            ],
            ':type/:id': [
                {handler: this.update},
                {handler: this.remove, method: 'delete'}
            ]
        };
    }
}