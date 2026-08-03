use crate::errors::{InternalError, Result};

/// Validation and sanitization helpers for recordForge IPC inputs.
pub struct Validation;

impl Validation {
    /// Ensure a string is a valid UUIDv4.
    pub fn uuid(id: &str, field_name: &str) -> Result<String> {
        uuid::Uuid::parse_str(id)
            .map_err(|_| {
                InternalError::Permissions(format!(
                    "invalid format for '{field_name}': must be a valid UUID"
                ))
            })?;
        Ok(id.to_string())
    }

    /// Ensure a string parameter is non-empty and bounded in length.
    pub fn string(value: &str, field_name: &str, max_len: usize) -> Result<String> {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            return Err(InternalError::Permissions(format!(
                "field '{field_name}' cannot be empty"
            ))
            .into());
        }
        if trimmed.len() > max_len {
            return Err(InternalError::Permissions(format!(
                "field '{field_name}' exceeds maximum length of {max_len} characters"
            ))
            .into());
        }
        Ok(trimmed.to_string())
    }

    /// Ensure a number is within a specified range [min, max].
    pub fn range_i32(value: i32, field_name: &str, min: i32, max: i32) -> Result<i32> {
        if value < min || value > max {
            return Err(InternalError::Permissions(format!(
                "field '{field_name}' ({value}) is outside allowed range [{min}, {max}]"
            ))
            .into());
        }
        Ok(value)
    }
}
