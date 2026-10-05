/** Report fixed failure categories only: child errors may contain URLs or credentials. */
export function sourceFailureCode(error: unknown) {
  const value = error && typeof error === 'object' ? error as Record<string, unknown> : {};
  const message = typeof value.message === 'string' ? value.message : '';
  const known = new Map([
    ['Source acquisition is already owned or awaiting recovery.', 'cache_fenced'],
    ['Source cache storage admission is full; reclaim inactive caches before retrying.', 'storage_full'],
    ['Workspace storage requires the encrypted provider volume.', 'encrypted_volume_unavailable'],
    ['Authorized source Git operation failed. Check repository access, exact revision, storage capacity, and fetch timeout.', 'git_failed'],
    ['Source acquisition authority expired.', 'authority_expired'],
    ['Workspace build is unavailable or already owned.', 'builder_fenced'],
    ['Source cache recovery still has an attached loop device.', 'cache_transport_retained'],
    ['Source cache mount ownership is uncertain.', 'cache_mount_ownership'],
    ['Source cache quota/custody changed; explicit recovery required.', 'cache_quota_changed'],
    ['Source cache recovery custody is invalid.', 'cache_recovery_custody'],
    ['Source cache directory escaped private custody.', 'cache_custody'],
    ['Invalid source Git credential.', 'git_credential_invalid'],
    ['Workspace builder has no trusted guest image.', 'builder_image_unavailable'],
    ['Source bundle is not verified manager custody.', 'bundle_custody'],
    ['Workspace source build was stopped.', 'builder_stopped'],
  ]);
  if (known.has(message)) return `source_${known.get(message)}`;
  const command = typeof value.cmd === 'string' ? value.cmd.split(' ')[0] : '';
  const commands: Record<string, string> = { '/usr/bin/mount': 'cache_mount', '/usr/bin/umount': 'cache_unmount',
    '/usr/bin/fallocate': 'cache_allocate', '/usr/sbin/mkfs.ext4': 'filesystem_create',
    '/usr/bin/qemu-img': 'image_create', '/usr/sbin/modprobe': 'block_module', '/usr/bin/ctr': 'builder_vm',
    '/usr/bin/systemd-run': 'block_service', '/usr/sbin/losetup': 'loop_ownership' };
  const codes = new Set(['EACCES','EPERM','ENOENT','ENOSPC','EROFS','EBUSY','ETIMEDOUT']);
  const code = typeof value.code === 'string' && codes.has(value.code) ? value.code.toLowerCase()
    : Number.isSafeInteger(value.code) ? `exit_${value.code}` : 'failed';
  return `source_${commands[command ?? ''] ?? 'preparation'}_${code}`;
}
