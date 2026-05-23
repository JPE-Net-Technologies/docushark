//! Password hashing using bcrypt
//!
//! Provides secure password hashing and verification.

use bcrypt::{hash, verify, DEFAULT_COST};

/// Hash a password using bcrypt
///
/// Returns the hashed password string that can be stored in the database.
pub fn hash_password(password: &str) -> Result<String, String> {
    hash(password, DEFAULT_COST).map_err(|e| format!("Password hashing error: {}", e))
}

/// Verify a password against a stored hash
///
/// Returns true if the password matches the hash.
pub fn verify_password(password: &str, hash: &str) -> Result<bool, String> {
    verify(password, hash).map_err(|e| format!("Password verification error: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hash_and_verify() {
        let password = "secure-password-123";
        let hash = hash_password(password).unwrap();

        // Hash should be different from password
        assert_ne!(hash, password);

        // Verification should succeed with correct password
        assert!(verify_password(password, &hash).unwrap());

        // Verification should fail with wrong password
        assert!(!verify_password("wrong-password", &hash).unwrap());
    }

    #[test]
    fn test_different_hashes_same_password() {
        let password = "test-password";

        let hash1 = hash_password(password).unwrap();
        let hash2 = hash_password(password).unwrap();

        // Each hash should be unique (different salt)
        assert_ne!(hash1, hash2);

        // But both should verify correctly
        assert!(verify_password(password, &hash1).unwrap());
        assert!(verify_password(password, &hash2).unwrap());
    }
}
