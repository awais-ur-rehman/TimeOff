import { DefaultNamingStrategy, NamingStrategyInterface } from 'typeorm';

function toSnakeCase(name: string): string {
  return name.replace(/([A-Z])/g, (match) => `_${match.toLowerCase()}`);
}

export class SnakeNamingStrategy
  extends DefaultNamingStrategy
  implements NamingStrategyInterface
{
  override columnName(
    propertyName: string,
    customName: string | undefined,
    embeddedPrefixes: string[],
  ): string {
    const base = customName ?? toSnakeCase(propertyName);
    return embeddedPrefixes.length
      ? embeddedPrefixes.map(toSnakeCase).join('_') + '_' + base
      : base;
  }

  override relationName(propertyName: string): string {
    return toSnakeCase(propertyName);
  }

  override joinColumnName(relationName: string, referencedColumnName: string): string {
    return toSnakeCase(`${relationName}_${referencedColumnName}`);
  }

  override joinTableColumnName(
    tableName: string,
    propertyName: string,
    columnName?: string,
  ): string {
    return toSnakeCase(`${tableName}_${columnName ?? propertyName}`);
  }
}
