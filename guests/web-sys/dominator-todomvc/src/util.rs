//! Unchanged from Dominator's TodoMVC except that `local_storage` is gone
//! with the persistence (see the crate docs).

#[inline]
pub fn trim(input: &str) -> Option<&str> {
    let trimmed = input.trim();

    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}
