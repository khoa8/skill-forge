# Security policy

## Reporting a vulnerability

Do not disclose vulnerability details, exploit instructions, or secrets in public
issues, pull requests, comments, or attachments.

The intended reporting mechanism for the public repository is GitHub Private
Vulnerability Reporting. Once the repository is public and that feature is
enabled, use **Security → Report a vulnerability** to submit a private report:
[Report a vulnerability](https://github.com/khoa8/skill-forge/security/advisories/new).

This mechanism is unavailable while the repository is private and must be enabled
after publication. This policy does not claim it is already enabled. If the private
reporting form is unavailable, do not fall back to a public issue or PR. Keep the
details private until private reporting is available; no alternative reporting
contact is designated by this policy.

In a private report, include the affected revision, environment, expected security
boundary, observed impact, and minimal reproduction steps using synthetic data.
Do not include live credentials, personal information, or proprietary source
material. This policy makes no response-time, remediation-time, or long-term
support commitment.

## Security scope

SkillForge is intended for local / trusted self-hosted use. It has no built-in
authentication, authorization, or tenant isolation. See the
[README deployment scope](README.md#deployment-scope-read-before-binding-beyond-loopback)
before exposing a server beyond loopback. Public repository visibility does not
change that deployment model.

Report defects that violate the documented security boundaries, including:

- URL-fetch SSRF or DNS-rebinding bypasses, including inbound Host validation.
- Filesystem containment escapes or unsafe exported package paths.
- Execution of imported content or generated commands by SkillForge.
- Credential leakage or unintended disclosure of source material.
- Bypasses of deterministic validation or server-side export validation.
- Violations of the GitHub ingestion public-repository or credential boundaries.

Remote providers receive source information as described in the
[README privacy guidance](README.md#remote-provider-source-data-egress-and-privacy).
Use only material you intend to disclose to the configured provider.
