# Capacity host qualification

KVM and actual TreeSeed Kata execution are mandatory. Root access, Docker,
GPU availability, a Terraform provider, and the presence of `/dev/kvm` do not
individually qualify a machine. There is no container-only fallback.

## Provider research

Reviewed 2026-09-06:

| Offering | Evidence | Decision |
| --- | --- | --- |
| Vultr Cloud Compute / Cloud GPU | Public VM documentation does not establish guest access to nested KVM | Unqualified; do not advertise as capacity |
| Vultr Bare Metal | Vendor documents unrestricted physical access, custom drivers, cloud-init, and OS installation | Candidate for exact-machine testing; not yet accepted |
| Hyperstack VMs | Vendor documents Linux images and SSH access, but no nested KVM guarantee was found | Unqualified; vendor confirmation and exact-machine testing required |
| Existing physical machine over SSH | Hardware and firmware controlled by its owner | Qualify each machine, then adopt without OS replacement |

Sources:

- <https://docs.vultr.com/products/compute/instances/cloud-compute/faq>
- <https://docs.vultr.com/products/compute/instances/bare-metal/faq>
- <https://docs.hyperstack.cloud/docs/virtual-machines/virtual-machine-features/>
- <https://registry.terraform.io/providers/vultr/vultr/latest/docs>
- <https://registry.terraform.io/providers/NexGenCloud/hyperstack/latest>

Lack of a published guarantee is not proof that a provider cannot support KVM.
Ask the vendor for the exact SKU, region, image, VMX/SVM exposure and `/dev/kvm`
support. GPU qualification additionally requires the requested GPU to work
inside the actual Kata guest, not merely on its host.

## SSH preflight boundary

Deployment exports `infrastructure/capacity/ssh`. The caller supplies a
deployment-authorized numeric destination, a separately trusted Ed25519 host
public key, and a short-lived vault custody read of the private SSH key.
The operation must run in the authorized runner's protected runtime directory,
normally beneath `/run/treeseed`; it must not run against arbitrary destinations
accepted directly from an untrusted service form.

The fixed read-only probe requires Ubuntu 26.04, x86_64, Debian package tools,
root authority (direct or noninteractive sudo), KVM API version 12, and a
successful `KVM_CREATE_VM` ioctl. Python 3 must already be installed. A successful
probe returns `kata-acceptance-required`, never an admission receipt.

SSH configuration files, SSH agents, forwarding, password fallback and
trust-on-first-use are disabled. A pinned IP avoids DNS rebinding between
authorization and connection. Temporary identity files are private and removed
in a finally block. Remote output is not exposed as a diagnostic.

## Remaining delivery gates

This preflight is not the installer or an OpenTofu resource implementation.
The owning issue is Deployment #529. Remaining work includes vault-backed
Services UI/API wiring, an adopted-host OpenTofu lifecycle, immutable bootstrap
delivery, provider registration, and real Kata acceptance. OpenTofu state must
contain only resource descriptors and digests, never private keys, recovery
material or registration credentials. Destroying an adopted-host state record
must never erase its machine, disks or unrelated infrastructure.

A canary requires the owner's explicit destination, user, trusted host key and
vault connection. Do not provision billable cloud instances merely to discover
whether nested virtualization is available.
