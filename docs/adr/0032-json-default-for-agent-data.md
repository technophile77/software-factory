# 0032. JSON is the default format for agent data

- **Status:** Accepted
- **Date:** 2026-11-14
- **Decided by:** owner
- **Decision item:** decision cards in the thread "Make JSON the default format for agent data": H-0240 approved as drafted, hand-edited configuration stays YAML (08:52Z), F-020 started with full scope (08:53Z); [proposal 0034](../proposals/0034-json-default-format.md)

## Problem

Agent data was a mix of JSON, YAML and free text. Free text can't be
checked by code, and the owner's rule is that agents report facts and code
makes decisions. See proposal 0034.

## Decision

Data an agent reads or writes is JSON, with a `schema` field and a JSON
Schema, unless one of the reasons in `docs/architecture.md` § Data formats
applies (H-0240). Hand-edited configuration stays YAML and gets a JSON
Schema. The remaining moves (inbox and PR records, advisor and web reader
answers, report fields, schemas, structured output) are F-020.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| JSON by default, stated exceptions (chosen) | Code can check every hand-over; one rule for every agent | Migration of inbox records; schema files to keep current |
| Hand-edited config as JSON too | One format everywhere | Loses comments; migration of every manifest |
| Hand-edited config as JSONC | Keeps comments | Needs a special parser in every consumer |

## Implications

No new dependency: schemas come from zod 4.6.7, already pinned, and
structured output from the pinned Agent SDK. Each contract change is its
own Interfaces decision in F-020 (H-0241 to H-0244).
