import _ from 'lodash';

/* eslint-disable no-mixed-operators */

export function max(measureField, srcField) {
    // TODO: measureField must be specified

    return {
        measureField,

        fields: [measureField, srcField],

        onAdd: (aggregateDoc, addedDoc) => _.max(_.get(aggregateDoc, measureField, 0), _.get(addedDoc, srcField, 0)),

        onRemove: (aggregateDoc, removedDoc) => _.get(aggregateDoc, measureField, 0),

        onUpdate: (aggregateDoc, oldDoc, updatedDoc) => _.max(_.get(aggregateDoc, measureField, 0), _.get(updatedDoc, srcField, 0))
    };
}

export function min(measureField, srcField) {
    // TODO: measureField must be specified

    return {
        measureField,

        fields: [measureField, srcField],

        onAdd: (aggregateDoc, addedDoc) => _.max(_.get(aggregateDoc, measureField, 0), _.get(addedDoc, srcField, 0)),

        onRemove: (aggregateDoc, removedDoc) => _.get(aggregateDoc, measureField, 0),

        onUpdate: (aggregateDoc, oldDoc, updatedDoc) => _.max(_.get(aggregateDoc, measureField, 0), _.get(updatedDoc, srcField, 0))
    };
}

export function range(measureField, srcField) {
    // TODO: measureField must be specified

    if (!srcField) {
        srcField = measureField;
    }

    return {
        measureField,

        fields: [measureField, srcField],

        onAdd: (aggregateDoc, addedDoc) => {
            const measureValue = _.get(aggregateDoc, measureField, {min: null, max: null, __values_internal__: []});

            const srcValue = _.get(addedDoc, srcField, 0);

            let found = false;
            _.forEach(measureValue.__values_internal__, (value) => {
                if (value.key === srcValue) {
                    found = true;
                    value.count += 1;
                }
            });

            if (!found) {
                measureValue.__values_internal__.push({key: srcValue, count: 1});
                if (_.isNull(measureValue.min) || measureValue.min > srcValue) {
                    measureValue.min = srcValue;
                }

                if (_.isNull(measureValue.max) || measureValue.max < srcValue) {
                    measureValue.max = srcValue;
                }
            }

            return measureValue;
        },

        onRemove: (aggregateDoc, removedDoc) => {
            const measureValue = _.get(aggregateDoc, measureField, {min: null, max: null, __values_internal__: []});

            const srcValue = _.get(removedDoc, srcField, 0);

            let indexToDelete = -1;
            _.forEach(measureValue.__values_internal__, (value, index) => {
                if (value.key === srcValue) {
                    value.count -= 1;

                    if (value.count === 0) {
                        // remove this entry from measureValue.__values_internal__
                        indexToDelete = index;
                    }
                }
            });

            if (indexToDelete >= 0) {
                _.pullAt(measureValue.__values_internal__, indexToDelete);

                // update min and max too
                if (_.isNull(measureValue.min) || measureValue.min > srcValue) {
                    const minValue = _.minBy(measureValue.__values_internal__, value => value.key);
                    if (minValue) {
                        measureValue.min = minValue.key;
                    } else {
                        measureValue.min = null;
                    }
                }

                if (_.isNull(measureValue.max) || measureValue.max < srcValue) {
                    const maxValue = _.maxBy(measureValue.__values_internal__, value => value.key);
                    if (maxValue) {
                        measureValue.max = maxValue.key;
                    } else {
                        measureValue.max = null;
                    }
                }
            }

            return measureValue;
        },

        onUpdate: (aggregateDoc, oldDoc, updatedDoc) => {
            _.max(_.get(aggregateDoc, measureField, 0), _.get(updatedDoc, srcField, 0));

            const measureValue = _.get(aggregateDoc, measureField, {min: null, max: null, __values_internal__: []});

            const oldValue = _.get(oldDoc, srcField, 0);
            const updatedValue = _.get(updatedDoc, srcField, 0);

            let indexToDelete = -1;
            let found = false;
            _.forEach(measureValue.__values_internal__, (value, index) => {
                if (value.key === oldValue) {
                    value.count -= 1;

                    if (value.count === 0) {
                        // remove this entry from measureValue.__values_internal__
                        indexToDelete = index;
                    }
                }

                if (value.key === updatedValue) {
                    found = true;
                    value.count += 1;
                }
            });

            if (!found) {
                measureValue.__values_internal__.push({key: updatedValue, count: 1});
            }

            if (indexToDelete >= 0) {
                _.pullAt(measureValue.__values_internal__, indexToDelete);
            }

            // update min and max too
            if (_.isNull(measureValue.min) || measureValue.min > oldValue) {
                const minValue = _.minBy(measureValue.__values_internal__, value => value.key);
                if (minValue) {
                    measureValue.min = minValue.key;
                } else {
                    measureValue.min = null;
                }
            }

            if (_.isNull(measureValue.max) || measureValue.max < oldValue) {
                const maxValue = _.maxBy(measureValue.__values_internal__, value => value.key);
                if (maxValue) {
                    measureValue.max = maxValue.key;
                } else {
                    measureValue.max = null;
                }
            }

            return measureValue;
        }
    };
}

export function list(measureField, srcField, idFn) {
    // TODO: measureField must be specified

    if (!srcField) {
        srcField = measureField;
    }

    if (!idFn) {
        idFn = value => value;
    }

    return {
        measureField,

        fields: [measureField, srcField],

        onAdd: (aggregateDoc, addedDoc) => {
            const measureValue = _.get(aggregateDoc, measureField, []);

            let srcValues = _.get(addedDoc, srcField);

            if (!srcValues) {
                return measureValue;
            }

            if (!_.isArray(srcValues)) {
                srcValues = [srcValues];
            }

            let found = false;
            _.forEach(srcValues, (srcValue) => {
                _.forEach(measureValue, (value) => {
                    if (idFn(value) === idFn(srcValue)) {
                        found = true;

                        if (_.isObject(value)) {
                            value.__count_internal__ += 1;
                        }
                    }
                });

                if (!found) {
                    if (_.isObject(srcValue)) {
                        srcValue.__count_internal__ = 1;
                    }

                    measureValue.push(srcValue);
                }
            });

            return measureValue;
        },

        onRemove: (aggregateDoc, removedDoc) => {
            const measureValue = _.get(aggregateDoc, measureField, []);

            let srcValues = _.get(removedDoc, srcField);

            if (!srcValues) {
                return measureValue;
            }

            if (!_.isArray(srcValues)) {
                srcValues = [srcValues];
            }

            _.forEach(srcValues, (srcValue) => {
                let indexToDelete = -1;

                _.forEach(measureValue, (value, index) => {
                    if (idFn(value) === idFn(srcValue)) {
                        if (_.isObject(value)) {
                            value.__count_internal__ -= 1;
                            if (value.__count_internal__ === 0) {
                                // remove this entry from measureValue
                                indexToDelete = index;
                            }
                        }
                    }
                });

                if (indexToDelete >= 0) {
                    _.pullAt(measureValue, indexToDelete);
                }
            });

            return measureValue;
        },

        onUpdate: (aggregateDoc, oldDoc, updatedDoc) => {
            _.max(_.get(aggregateDoc, measureField, 0), _.get(updatedDoc, srcField, 0));

            const measureValue = _.get(aggregateDoc, measureField, []);

            const oldValues = _.get(oldDoc, srcField);
            const updatedValues = _.get(updatedDoc, srcField);

            _.forEach(oldValues, (oldValue) => {
                let indexToDelete = -1;

                _.forEach(measureValue, (value, index) => {
                    if (idFn(value) === idFn(oldValue)) {
                        if (_.isObject(value)) {
                            value.__count_internal__ -= 1;
                            if (value.__count_internal__ === 0) {
                                // remove this entry from measureValue
                                indexToDelete = index;
                            }
                        }
                    }
                });

                if (indexToDelete >= 0) {
                    _.pullAt(measureValue, indexToDelete);
                }
            });

            _.forEach(updatedValues, (updatedValue) => {
                let found = false;

                _.forEach(measureValue, (value) => {
                    if (idFn(value) === idFn(updatedValue)) {
                        if (_.isObject(value)) {
                            value.__count_internal__ += 1;
                            found = true;
                        }
                    }
                });

                if (!found) {
                    measureValue.push(updatedValue);
                }
            });

            return measureValue;
        }
    };
}

export function count(measureField) {
    // if field is not specified then assumes 'count' field
    if (!measureField) {
        measureField = 'count';
    }

    return {
        measureField,

        fields: [measureField],

        onAdd: aggregateDoc => _.get(aggregateDoc, measureField, 0) + 1,

        onRemove: aggregateDoc => _.get(aggregateDoc, measureField, 0) - 1,

        onUpdate: aggregateDoc => _.get(aggregateDoc, measureField, 0)
    };
}

export function sum(measureField, srcField) {
    // TODO: measureField must be specified

    if (!srcField) {
        srcField = measureField;
    }

    return {
        measureField,

        fields: [measureField, srcField],

        onAdd: (aggregateDoc, addedDoc) => _.get(aggregateDoc, measureField, 0) + _.get(addedDoc, srcField, 0),

        onRemove: (aggregateDoc, removedDoc) => _.get(aggregateDoc, measureField, 0) - _.get(removedDoc, srcField, 0),

        onUpdate: (aggregateDoc, oldDoc, updatedDoc) => _.get(aggregateDoc, measureField, 0) - _.get(oldDoc, srcField, 0) + -_.get(updatedDoc, srcField, 0)
    };
}

export function average(measureField, srcField, countField, roundOff) {
    // TODO: measureField must be specified
    // TODO: field must be specified

    // if count field is not specified assumes 'count' field
    if (!countField) {
        countField = 'count';
    }

    if (!roundOff) {
        roundOff = 3;
    }

    return {
        measureField,

        roundOff,

        fields: [measureField, srcField, countField],

        onAdd: (aggregateDoc, addedDoc) => {
            const totalValue = _.get(aggregateDoc, measureField, 0) * _.get(aggregateDoc, countField, 0) + _.get(addedDoc, srcField, 0);
            const totalCount = _.get(aggregateDoc, countField, 0) + 1;
            return totalValue / totalCount;
        },

        onRemove: (aggregateDoc, removedDoc) => {
            const totalValue = _.get(aggregateDoc, measureField, 0) * _.get(aggregateDoc, countField, 0) - _.get(removedDoc, srcField, 0);
            const totalCount = _.get(aggregateDoc, countField, 0) - 1;
            return totalValue / totalCount;
        },

        onUpdate: (aggregateDoc, oldDoc, updatedDoc) => {
            const totalValue = _.get(aggregateDoc, measureField, 0) * _.get(aggregateDoc, countField, 0) - _.get(oldDoc, srcField, 0) + _.get(updatedDoc, srcField, 0);
            const totalCount = _.get(aggregateDoc, countField, 0);
            return totalValue / totalCount;
        }
    };
}

export function weightedAverage(measureField, srcField, weightField, roundOff, srcIsAverage) {
    // TODO: measureField must be specified
    // TODO: field must be specified
    // TODO: weightField must be specified

    if (!roundOff) {
        roundOff = 3;
    }

    return {
        measureField,

        roundOff,

        fields: [measureField, srcField, weightField],

        onAdd: (aggregateDoc, addedDoc) => {
            const totalValue = _.get(aggregateDoc, measureField, 0) * _.get(aggregateDoc, weightField, 0)
              + _.get(addedDoc, srcField, 0) * (srcIsAverage ? _.get(addedDoc, weightField, 0) : 1);
            const totalCount = _.get(aggregateDoc, weightField, 0) + _.get(addedDoc, weightField, 0);
            return totalValue / totalCount;
        },

        onRemove: (aggregateDoc, removedDoc) => {
            const totalValue = _.get(aggregateDoc, measureField, 0) * _.get(aggregateDoc, weightField, 0)
              - _.get(removedDoc, srcField, 0) * (srcIsAverage ? _.get(removedDoc, weightField, 0) : 1);
            const totalCount = _.get(aggregateDoc, weightField, 0) - _.get(removedDoc, weightField, 0);
            return totalValue / totalCount;
        },

        onUpdate: (aggregateDoc, oldDoc, updatedDoc) => {
            const totalValue = _.get(aggregateDoc, measureField, 0) * _.get(aggregateDoc, weightField, 0)
              - _.get(oldDoc, srcField, 0) * (srcIsAverage ? _.get(oldDoc, weightField, 0) : 1)
              + _.get(updatedDoc, srcField, 0) * (srcIsAverage ? _.get(updatedDoc, weightField, 0) : 1);
            const totalCount = _.get(aggregateDoc, weightField, 0) - _.get(oldDoc, weightField, 0) + _.get(updatedDoc, weightField, 0);
            return totalValue / totalCount;
        }
    };
}