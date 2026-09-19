# Security

sysone's boundary is small: a loopback HTTP endpoint that forwards
schema-validated System One requests to configured backends. The things that
must not cross it — the hosted credential reaching anywhere but the
configured `base_url`, request or answer bodies landing in logs or on disk,
a listener escaping loopback, a model bypassing SHA-256/GGUF/store admission,
an immutable release carrying bytes other than the checked artifact, or input
exceeding its documented bounds — are the issues we want reported.

## Reporting

Open a private security advisory on the GitHub repository
(`hraness/sysone`, Security → Advisories) or email the maintainers through
the contact listed on the organization profile. Please include a minimal
reproduction or test that demonstrates the issue where possible.

Do not open a public issue for an unpatched vulnerability.
