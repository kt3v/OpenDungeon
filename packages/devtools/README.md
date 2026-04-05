# @opendungeon/devtools

CLI and development tools for creating and validating OpenDungeon modules.

## Features

- **Module Validation**: Ensure your `manifest.json` conforms to the latest engine standards.
- **Architect CLI**: Access world-building and campaign generation directly from your terminal.

## Installation

```bash
pnpm add -g @opendungeon/devtools
```

## Usage

```bash
# Validate your module's manifest
od validate-module ./my-module/manifest.json

# Run campaign generation
od architect --campaign campaign-1 --apply
```
