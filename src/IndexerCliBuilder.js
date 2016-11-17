import _ from 'lodash';

import {Command} from 'command-line-boilerplate/lib/CliBuilder';

export default function (indexerBuilder, indicesConfig) {
    new Command('createAllIndices')
      .description('Creates All Index Settings and Mappings')
      .action(() => indexerBuilder().createIndex());

    new Command('deleteAllIndices')
      .description('Deletes All Indices Data, Settings, and Mappings')
      .action(() => indexerBuilder().deleteIndex());

    _(indicesConfig.indices)
      .keys()
      .forEach((indexKey) => {
          const name = _.upperFirst(_.camelCase(indexKey));

          new Command(`create${name}Index`)
            .description(`Creates ${name} Index Settings and Mappings`)
            .action(() => indexerBuilder().createIndex(indexKey));

          new Command(`delete${name}Index`)
            .description(`Deletes ${name} Index Data, Settings, and Mappings`)
            .action(() => indexerBuilder().deleteIndex(indexKey));
      });

    _(indicesConfig.types)
      .keys()
      .forEach((typeKey) => {
          const typeConfig = indicesConfig.types[typeKey];
          if (typeConfig.child) {
              return true;
          }

          const name = _.upperFirst(_.camelCase(typeKey));

          new Command(`upsert${name}`)
            .option(`-d, --data <${typeKey}-data>`, `${name} data in JSON format`)
            .description(`Upserts ${name}`)
            .action(args => indexerBuilder.upsert(null, {type: typeConfig.type, doc: JSON.parse(args.data)}));

          new Command(`add${name}`)
            .option(`-d, --data <${typeKey}-data>`, `${name} data in JSON format`)
            .description(`Adds ${name}`)
            .action(args => indexerBuilder.add(null, {type: typeConfig.type, doc: JSON.parse(args.data)}));

          new Command(`update${name}`)
            .option(`-d, --data <${typeKey}-data>`, `${name} data in JSON format`)
            .description(`Updates ${name}`)
            .action(args => indexerBuilder.update(null, {type: typeConfig.type, doc: JSON.parse(args.data)}));

          new Command(`delete${name}`)
            .option('--id <id>', `ID of the ${typeKey} to delete`)
            .description(`Deletes ${name}`)
            .action(args => indexerBuilder.remove(null, {type: typeConfig.type, id: args.id}));

          return true;
      });
}