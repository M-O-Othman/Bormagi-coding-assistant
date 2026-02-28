# Publishing Bormagi to the VS Code Marketplace

## Prerequisites

| Requirement | Notes |
|---|---|
| Node.js ≥ 18 | Needed for `@vscode/vsce` |
| `@vscode/vsce` | Already a devDependency — `npm install` suffices |
| Microsoft account | To sign in to the Marketplace |
| Azure DevOps organisation | Free; used only to generate the PAT |
| Unique publisher ID | Verify at https://marketplace.visualstudio.com/manage |

---

## Step 1 — Choose and verify the publisher name

1. Go to https://marketplace.visualstudio.com/manage
2. Sign in with your Microsoft account.
3. Click **Create publisher**.
4. Try the name `MohammedOthman`. If taken, use `MohammedOOthman` or `MohammedOthmanDev`.
5. Copy the exact publisher ID — it must match `"publisher"` in `package.json`.
6. Update `package.json`:

```json
"publisher": "<your-publisher-id>"
```

---

## Step 2 — Generate a Personal Access Token (PAT)

1. Go to https://dev.azure.com and sign in.
2. Create a new organisation if you don't have one (any name).
3. Click your avatar → **Personal Access Tokens** → **New Token**.
4. Set **Organization** to `All accessible organizations`.
5. Set **Scopes** to **Custom defined** → expand **Marketplace** → check **Manage**.
6. Set an expiry (90 days recommended).
7. Click **Create** and **copy the token immediately** — it is not shown again.

---

## Step 3 — Generate the marketplace icon

The icon must be a 128×128 PNG file at `media/icon.png`.

```bash
npm run generate-icon
```

This script uses `sharp` to composite `media/bormagi-icon.svg` onto a dark `#1a1a2e` background.
Verify the output looks correct before packaging.

---

## Step 4 — Authenticate vsce

```bash
npx vsce login <your-publisher-id>
# Paste your PAT when prompted
```

---

## Step 5 — Package and test locally

```bash
npm run vsce:package
```

This creates a `.vsix` file in the extension root (e.g. `bormagi-0.1.0.vsix`).

To install it in VS Code for local testing:

```
Extensions panel → ··· menu → Install from VSIX → select the .vsix file
```

Verify the extension activates, agents work, and the Marketplace description looks correct.

---

## Step 6 — Publish

```bash
npm run vsce:publish
```

The extension will appear at:
`https://marketplace.visualstudio.com/items?itemName=<publisher-id>.bormagi`

Publication can take a few minutes to propagate.

---

## Updating the extension

Bump the `version` field in `package.json` (semver: `0.1.0` → `0.2.0` etc.) then re-run `vsce:publish`.

---

## Automated publishing with GitHub Actions

Add the following workflow to `.github/workflows/publish.yml` to publish automatically when you push a version tag:

```yaml
name: Publish

on:
  push:
    tags:
      - 'v*'

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: npm run generate-icon
      - run: npx vsce publish --pat ${{ secrets.VSCE_PAT }}
```

Store your PAT as a GitHub Actions secret named `VSCE_PAT`.

---

## Notes

- The `"publisher"` field in `package.json` **must exactly match** your Marketplace publisher profile name.
- The PAT expires — renew it before attempting to publish after the expiry date.
- The `.vscodeignore` file controls what is bundled. Run `vsce ls` to inspect the package contents before publishing.
