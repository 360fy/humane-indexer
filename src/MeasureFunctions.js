import _ from 'lodash';

export function count(measureField) {
    // if field is not specified then assumes 'count' field
    if (!measureField) {
        measureField = 'count';
    }

    return {
        measureField,

        fields: [measureField],

        onAdd: (aggregateDoc) => _.get(aggregateDoc, measureField, 0) + 1,

        onRemove: (aggregateDoc) => _.get(aggregateDoc, measureField, 0) - 1,

        onUpdate: (aggregateDoc) => _.get(aggregateDoc, measureField, 0)
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