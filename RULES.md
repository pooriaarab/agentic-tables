# agentic-tables rules

These rules bind every agent that uses this package.

1. Read the schema before you write a row.
2. Report a failed call as a failure. Do not present it as success.
3. Preview a schema change with a dry run before you apply it.
4. Do not retry a rejected row with changed values to get past a check.
