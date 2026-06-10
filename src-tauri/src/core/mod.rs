//! Core domain logic, UI-independent (see docs/tech/adr-0002-tech-stack.md).
//! Each submodule maps to a Phase 2 issue; keep modules self-contained.

pub mod frontmatter;
pub mod fswrite;
pub mod index;
pub mod reconcile;
pub mod recurrence;
pub mod trash;
