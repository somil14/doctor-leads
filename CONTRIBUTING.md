# Contributing to doctor-leads

Thanks for helping. The full rules and process are in the
[Contributing section of the README](README.md#contributing). This page is the
short version.

## Before you start

- Open an issue first for anything larger than a small fix.
- New data sources, and anything that guesses contact details, need agreement
  before code is written.

## Setup

```sh
git clone https://github.com/<your-username>/doctor-leads.git
cd doctor-leads
npm install
npm test
```

No API key is needed to run the tests.

## Checklist for a pull request

- [ ] Branch from `main`, named `feat/<topic>`, `fix/<topic>` or `docs/<topic>`
- [ ] `npm test` passes
- [ ] New behaviour has a test; a bug fix has a test that fails without it
- [ ] No API keys, and no real names, phone numbers, emails or files from
      `cache/`, `output/` or `data/`
- [ ] New logic is a pure function; network and disk access is injected
- [ ] Exported functions have JSDoc
- [ ] README updated if flags, columns, config or behaviour changed
- [ ] A line added under `[Unreleased]` in `CHANGELOG.md`
- [ ] Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)

## Conduct

Be respectful and assume good faith. Harassment or personal attacks are not
tolerated.
