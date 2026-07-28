export interface Migration<T> {
  from: string;
  to: string;
  migrate(input: unknown): T;
}

export class MigrationRegistry<T> {
  constructor(private readonly migrations: readonly Migration<T>[]) {}

  migrate(version: string, input: unknown): T {
    const visited = new Set<string>();
    let currentVersion = version;
    let currentInput = input;

    while (true) {
      const migration = this.migrations.find((candidate) => candidate.from === currentVersion);
      if (!migration) {
        throw new Error(`No migration registered for version: ${currentVersion}`);
      }
      if (visited.has(migration.from)) {
        throw new Error(`Migration cycle detected at version: ${migration.from}`);
      }
      visited.add(migration.from);
      const migrated = migration.migrate(currentInput);
      if (!this.migrations.some((candidate) => candidate.from === migration.to)) {
        return migrated;
      }
      currentVersion = migration.to;
      currentInput = migrated;
    }
  }
}
