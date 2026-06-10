// Error type for the index module.

use std::fmt;

/// Errors returned by `Index` operations.
#[derive(Debug)]
pub enum IndexError {
    Sqlite(rusqlite::Error),
    /// Schema migration failed.
    Migration(String),
}

impl fmt::Display for IndexError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            IndexError::Sqlite(e) => write!(f, "sqlite: {e}"),
            IndexError::Migration(msg) => write!(f, "migration: {msg}"),
        }
    }
}

impl std::error::Error for IndexError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            IndexError::Sqlite(e) => Some(e),
            IndexError::Migration(_) => None,
        }
    }
}

impl From<rusqlite::Error> for IndexError {
    fn from(e: rusqlite::Error) -> Self {
        IndexError::Sqlite(e)
    }
}
