"""
Feature toggles for Kudagu CRM.

These toggles are intentionally plain Python so the deployment owner can
enable/disable features by commenting one line and uncommenting the other.

Example:
    # USERNAME_PASSWORD_AUTH_ENABLED = False
    USERNAME_PASSWORD_AUTH_ENABLED = True
"""

# Toggle username/password authentication.
USERNAME_PASSWORD_AUTH_ENABLED = False
# USERNAME_PASSWORD_AUTH_ENABLED = True

# Toggle the multi-role user model (admin / partner / employee).
ROLE_BASED_ACCESS_ENABLED = True
# ROLE_BASED_ACCESS_ENABLED = True

# Session lifetime for signed-in users.
SESSION_TTL_HOURS = 12
