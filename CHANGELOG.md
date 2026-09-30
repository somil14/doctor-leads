# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `--nearby`: Nearby Search grid sweep around each town. A circle that comes
  back full is split in four, up to `nearby.maxDepth` times. Sweep centres are
  saved in the cache directory so later runs reuse the cached circles.
- `--reviews-under <N>` and `--weak-website`: write `call_list_<date>.csv` for
  the matching leads, with WhatsApp links and the verification columns.
- `websiteStatus` column.
- `areaPinPrefixes`: PIN prefixes that place an address in the target area on
  their own, which keeps village listings that name no listed town.
- `townCenters` and `nearby` config settings.
- `Alternative/Allied` specialty for homeopathy, ayurveda, physiotherapy and
  similar practices.

### Changed

- A lead whose address names no listed town is filed under the town whose
  search found it, instead of `Unknown`.
- Opticians, surgical-supply shops and other shop-like names are excluded as
  `not_medical` even when Google types them as a doctor or hospital.
- Lab chains and Hindi lab names are excluded as `diagnostic_lab`.

## [1.1.0] - 2026-09-30

### Added

- Optional `config.local.json`: private, git-ignored overrides of
  `src/config.js`, so a target area never has to be committed.
- Tests for config validation, merging and loading.

### Changed

- The shipped default area is now Bangalore (Koramangala, Indiranagar,
  Jayanagar, Whitefield, Malleshwaram). To keep a previous area, put its
  `towns`, `state`, `allowedDistricts`, `townAliases` and `allowedPinPrefixes`
  in `config.local.json`.
- README and code comments use Bangalore as the reference example.

## [1.0.0] - 2026-09-30

First release.

### Added

- Google Places API (New) Text Search client with pagination (up to 3 pages),
  concurrency limit, exponential backoff with jitter, and a disk cache of raw
  responses.
- Cost controls: `--dry-run`, `--towns`, `--terms`, `--max-calls`.
- Area filter by district name, or listed town plus PIN prefix, with alternate
  town spellings.
- Phone normalisation to E.164 and line-type detection from the Indian
  numbering plan.
- Dedupe by place id, then by phone when the names also match; shared numbers
  are flagged instead of merged.
- Specialty classification, exclusion of pharmacies, diagnostic labs, vets and
  non-medical listings, entity type, town extraction and A/B/C priority.
- Website enrichment: emails and phones from each practice's own site, with
  robots.txt support, per-site page limit and disk cache.
- Mail-domain check and address typing (`named`, `role`, `other`).
- Confidence levels for every phone and email.
- Manual verification workflow: `verification_sheet_<date>.csv` out,
  `data/verified.csv` in, applied on every run.
- CSV and JSON output, excluded-records file and a console summary.
- Unit tests for every module and a GitHub Actions workflow.

[Unreleased]: https://github.com/somil14/doctor-leads/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/somil14/doctor-leads/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/somil14/doctor-leads/releases/tag/v1.0.0
