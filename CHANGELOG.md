# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- README uses Bangalore as its reference example and documents an example
  area configuration.

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

[Unreleased]: https://github.com/somil14/doctor-leads/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/somil14/doctor-leads/releases/tag/v1.0.0
