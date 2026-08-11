#define _DARWIN_C_SOURCE 1
#define _POSIX_C_SOURCE 200809L

/*
 * Descriptor-anchored filesystem mutations for the live-proof harness.
 *
 * Node 22 exposes O_NOFOLLOW for a final open, but it does not expose openat,
 * fstatat(AT_SYMLINK_NOFOLLOW), or unlinkat. Those calls are required here:
 * provider-controlled files live below a same-UID temporary home, so checking
 * a pathname and later unlinking that pathname leaves an intermediate-symlink
 * race. This helper opens the real temp root once, admits one fixed-shape
 * direct child, pins every directory by (device,inode), and performs all later
 * traversal and mutation relative to those descriptors.
 *
 * Keep this program deliberately dependency-free and its CLI closed: callers
 * cannot supply an operation, temp root, home, identity, or child path. The
 * parent compiles exactly one reviewed operation/target binding into each
 * short-lived executable.
 */

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

/* Every executable is compiled for exactly one operation and one proof home
 * after the provider process is gone. There is intentionally no generic CLI:
 * a copied helper can never be retargeted at another temp root or sibling. */
#ifndef PROOF_BOUND_OPERATION
#error "runtime-safety-native requires a bound operation"
#endif
#ifndef PROOF_BOUND_TEMP_ROOT
#error "runtime-safety-native requires a bound temp root"
#endif
#ifndef PROOF_BOUND_TEMP_DEVICE
#error "runtime-safety-native requires a bound temp-root device"
#endif
#ifndef PROOF_BOUND_TEMP_INODE
#error "runtime-safety-native requires a bound temp-root inode"
#endif
#ifndef PROOF_BOUND_HOME_NAME
#error "runtime-safety-native requires a bound proof-home name"
#endif
#ifndef PROOF_BOUND_HOME_DEVICE
#error "runtime-safety-native requires a bound proof-home device"
#endif
#ifndef PROOF_BOUND_HOME_INODE
#error "runtime-safety-native requires a bound proof-home inode"
#endif
#ifndef PROOF_BOUND_ENFORCE_STATE
#error "runtime-safety-native requires an explicit state-identity policy"
#endif
#ifndef PROOF_BOUND_STATE_DEVICE
#error "runtime-safety-native requires a bound proof-state device slot"
#endif
#ifndef PROOF_BOUND_STATE_INODE
#error "runtime-safety-native requires a bound proof-state inode slot"
#endif

#ifndef O_CLOEXEC
#define O_CLOEXEC 0
#endif
#ifndef O_NOFOLLOW
#error "runtime-safety-native requires O_NOFOLLOW"
#endif
#ifndef AT_SYMLINK_NOFOLLOW
#error "runtime-safety-native requires AT_SYMLINK_NOFOLLOW"
#endif

#define MAX_REMOVE_DEPTH 128
#define MAX_LOG_BYTES (2 * 1024 * 1024)

static int failures = 0;

static void report_failure(const char *format, ...) {
  va_list args;
  failures += 1;
  fputs("proof-fs: ", stderr);
  va_start(args, format);
  vfprintf(stderr, format, args);
  va_end(args);
  fputc('\n', stderr);
}

static int same_identity(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino;
}

static int matches_identity(const struct stat *stats, uint64_t device, uint64_t inode) {
  return (uint64_t)stats->st_dev == device && (uint64_t)stats->st_ino == inode;
}

static int valid_home_name(const char *name) {
  static const char prefix[] = "clemmy-proof-";
  const unsigned char *cursor;
  if (strncmp(name, prefix, sizeof(prefix) - 1) != 0 || name[sizeof(prefix) - 1] == '\0') {
    return 0;
  }
  cursor = (const unsigned char *)name + sizeof(prefix) - 1;
  for (; *cursor != '\0'; cursor += 1) {
    if ((*cursor >= 'a' && *cursor <= 'z')
        || (*cursor >= 'A' && *cursor <= 'Z')
        || (*cursor >= '0' && *cursor <= '9')
        || *cursor == '.' || *cursor == '_' || *cursor == '-') continue;
    return 0;
  }
  return 1;
}

static int inspect_at(int parent_fd, const char *name, struct stat *stats) {
  if (fstatat(parent_fd, name, stats, AT_SYMLINK_NOFOLLOW) == 0) return 0;
  if (errno == ENOENT) return 1;
  report_failure("could not inspect exact entry %s: %s", name, strerror(errno));
  return -1;
}

/* Open one directory entry without following its final component, then prove
 * that the descriptor, the pre-open entry, and the post-open entry are the
 * same inode. parent_fd is already trusted, so intermediate components do not
 * exist in this operation. */
static int open_pinned_directory(
  int parent_fd,
  const char *name,
  int enforce_expected,
  uint64_t expected_device,
  uint64_t expected_inode,
  const char *label,
  struct stat *opened_stats
) {
  struct stat before;
  struct stat after;
  int fd;
  int inspected = inspect_at(parent_fd, name, &before);
  if (inspected == 1) {
    report_failure("%s is missing: %s", label, name);
    return -1;
  }
  if (inspected != 0) return -1;
  if (!S_ISDIR(before.st_mode)) {
    report_failure("%s is not a no-follow regular directory: %s", label, name);
    return -1;
  }
  if (enforce_expected && !matches_identity(&before, expected_device, expected_inode)) {
    report_failure("%s identity changed before native custody: %s", label, name);
    return -1;
  }

  fd = openat(parent_fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) {
    report_failure("could not open pinned %s %s: %s", label, name, strerror(errno));
    return -1;
  }
  if (fstat(fd, opened_stats) != 0) {
    report_failure("could not inspect opened %s %s: %s", label, name, strerror(errno));
    close(fd);
    return -1;
  }
  if (!S_ISDIR(opened_stats->st_mode)
      || !same_identity(&before, opened_stats)
      || (enforce_expected && !matches_identity(opened_stats, expected_device, expected_inode))) {
    report_failure("%s identity changed while it was opened: %s", label, name);
    close(fd);
    return -1;
  }
  if (fstatat(parent_fd, name, &after, AT_SYMLINK_NOFOLLOW) != 0
      || !same_identity(opened_stats, &after)) {
    report_failure("%s directory entry changed after it was opened: %s", label, name);
    close(fd);
    return -1;
  }
  return fd;
}

static int remove_entry_at(int parent_fd, const char *name, dev_t root_device, int depth);

static int remove_directory_children(int directory_fd, dev_t root_device, int depth) {
  DIR *stream;
  struct dirent *entry;
  int duplicate;
  int ok = 1;

  if (depth > MAX_REMOVE_DEPTH) {
    report_failure("refusing recursive cleanup deeper than %d levels", MAX_REMOVE_DEPTH);
    return 0;
  }
  duplicate = dup(directory_fd);
  if (duplicate < 0) {
    report_failure("could not duplicate cleanup directory descriptor: %s", strerror(errno));
    return 0;
  }
  stream = fdopendir(duplicate);
  if (stream == NULL) {
    report_failure("could not enumerate cleanup directory descriptor: %s", strerror(errno));
    close(duplicate);
    return 0;
  }
  errno = 0;
  while ((entry = readdir(stream)) != NULL) {
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    if (!remove_entry_at(directory_fd, entry->d_name, root_device, depth + 1)) ok = 0;
    errno = 0;
  }
  if (errno != 0) {
    report_failure("could not finish enumerating cleanup directory: %s", strerror(errno));
    ok = 0;
  }
  if (closedir(stream) != 0) {
    report_failure("could not close cleanup directory stream: %s", strerror(errno));
    ok = 0;
  }
  return ok;
}

/* Delete exactly name below an already-open parent. A symlink is unlinked as
 * an entry. A directory is opened O_NOFOLLOW, recursively emptied through that
 * descriptor, re-identified at the parent, then removed with AT_REMOVEDIR. */
static int remove_entry_at(int parent_fd, const char *name, dev_t root_device, int depth) {
  struct stat before;
  struct stat opened;
  struct stat current;
  int inspected = inspect_at(parent_fd, name, &before);
  int child_fd;
  int ok = 1;

  if (inspected == 1) return 1;
  if (inspected != 0) return 0;
  if (!S_ISDIR(before.st_mode)) {
    if (unlinkat(parent_fd, name, 0) != 0 && errno != ENOENT) {
      report_failure("could not unlink exact entry %s: %s", name, strerror(errno));
      return 0;
    }
    return 1;
  }
  if (before.st_dev != root_device) {
    report_failure("refusing to traverse cross-device directory entry %s", name);
    return 0;
  }
  child_fd = openat(parent_fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (child_fd < 0) {
    report_failure("could not open cleanup directory %s without following links: %s", name, strerror(errno));
    return 0;
  }
  if (fstat(child_fd, &opened) != 0 || !S_ISDIR(opened.st_mode) || !same_identity(&before, &opened)) {
    report_failure("cleanup directory identity changed while opening %s", name);
    close(child_fd);
    return 0;
  }
  if (!remove_directory_children(child_fd, root_device, depth)) ok = 0;
  if (close(child_fd) != 0) {
    report_failure("could not close cleanup directory %s: %s", name, strerror(errno));
    ok = 0;
  }
  if (!ok) return 0;
  if (fstatat(parent_fd, name, &current, AT_SYMLINK_NOFOLLOW) != 0) {
    if (errno == ENOENT) return 1;
    report_failure("could not re-identify cleanup directory %s: %s", name, strerror(errno));
    return 0;
  }
  if (!same_identity(&opened, &current)) {
    report_failure("cleanup directory entry changed before removal: %s", name);
    return 0;
  }
  if (unlinkat(parent_fd, name, AT_REMOVEDIR) != 0) {
    report_failure("could not remove exact directory %s: %s", name, strerror(errno));
    return 0;
  }
  return 1;
}

static int verify_directory_entry(int parent_fd, const char *name, const struct stat *opened, const char *label) {
  struct stat current;
  if (fstatat(parent_fd, name, &current, AT_SYMLINK_NOFOLLOW) != 0) {
    report_failure("could not verify retained %s entry %s: %s", label, name, strerror(errno));
    return 0;
  }
  if (!same_identity(opened, &current) || !S_ISDIR(current.st_mode)) {
    report_failure("retained %s entry changed during native operation: %s", label, name);
    return 0;
  }
  return 1;
}

static int release_reserve(int temp_fd, const char *home_name, uint64_t home_dev, uint64_t home_ino) {
  static const char reserve[] = ".proof-forensic-reserve";
  struct stat home_stats;
  struct stat reserve_stats;
  int home_fd = open_pinned_directory(
    temp_fd, home_name, 1, home_dev, home_ino, "proof home", &home_stats
  );
  if (home_fd < 0) return 0;
  if (fstatat(home_fd, reserve, &reserve_stats, AT_SYMLINK_NOFOLLOW) != 0) {
    if (errno == ENOENT) report_failure("proof forensic reserve is missing: %s/%s", home_name, reserve);
    else report_failure("could not inspect proof forensic reserve: %s", strerror(errno));
    close(home_fd);
    return 0;
  }
  if (!S_ISREG(reserve_stats.st_mode)) {
    report_failure("proof forensic reserve is not a no-follow regular file: %s/%s", home_name, reserve);
    close(home_fd);
    return 0;
  }
  if (unlinkat(home_fd, reserve, 0) != 0) {
    report_failure("could not release proof forensic reserve: %s", strerror(errno));
    close(home_fd);
    return 0;
  }
  if (fstatat(home_fd, reserve, &reserve_stats, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT) {
    report_failure("proof forensic reserve still exists after release: %s/%s", home_name, reserve);
  }
  verify_directory_entry(temp_fd, home_name, &home_stats, "proof home");
  close(home_fd);
  return failures == 0;
}

static int sanitize_home(
  int temp_fd,
  const char *home_name,
  uint64_t home_dev,
  uint64_t home_ino,
  int enforce_state,
  uint64_t state_dev,
  uint64_t state_ino
) {
  static const char *credentials[] = {
    "auth.json",
    "codex-access-only.json",
    "claude-auth.json",
    "secrets-vault.json"
  };
  struct stat home_stats;
  struct stat state_before;
  struct stat state_opened;
  struct stat state_current;
  int home_fd = open_pinned_directory(
    temp_fd, home_name, 1, home_dev, home_ino, "proof home", &home_stats
  );
  int state_status;
  size_t index;
  if (home_fd < 0) return 0;

  state_status = inspect_at(home_fd, "state", &state_before);
  if (state_status == 0 && S_ISDIR(state_before.st_mode)) {
    int state_fd;
    if (enforce_state && !matches_identity(&state_before, state_dev, state_ino)) {
      report_failure("proof state directory identity changed before sanitation: %s/state", home_name);
    } else {
      state_fd = open_pinned_directory(
        home_fd, "state", enforce_state, state_dev, state_ino, "proof state", &state_opened
      );
      if (state_fd >= 0) {
        for (index = 0; index < sizeof(credentials) / sizeof(credentials[0]); index += 1) {
          remove_entry_at(state_fd, credentials[index], state_opened.st_dev, 0);
        }
        if (fstatat(home_fd, "state", &state_current, AT_SYMLINK_NOFOLLOW) != 0
            || !same_identity(&state_opened, &state_current)) {
          report_failure("proof state entry changed during sanitation: %s/state", home_name);
          if (fstatat(home_fd, "state", &state_current, AT_SYMLINK_NOFOLLOW) == 0
              && S_ISLNK(state_current.st_mode)) {
            if (unlinkat(home_fd, "state", 0) != 0) {
              report_failure("could not unlink replacement proof state symlink: %s", strerror(errno));
            }
          }
        }
        close(state_fd);
      }
    }
  } else if (state_status == 0) {
    report_failure("proof state is not the pinned regular directory: %s/state", home_name);
    /* A non-directory state entry cannot contain the fixed nested credentials.
     * Remove only that exact entry; never follow it. */
    remove_entry_at(home_fd, "state", home_stats.st_dev, 0);
  }

  remove_entry_at(home_fd, ".env", home_stats.st_dev, 0);
  verify_directory_entry(temp_fd, home_name, &home_stats, "proof home");
  close(home_fd);
  return failures == 0;
}

static int remove_home(int temp_fd, const char *home_name, uint64_t home_dev, uint64_t home_ino) {
  struct stat before;
  struct stat opened;
  struct stat current;
  int inspected = inspect_at(temp_fd, home_name, &before);
  int home_fd;
  int ok;
  if (inspected == 1) return 1;
  if (inspected != 0) return 0;

  if (!S_ISDIR(before.st_mode)) {
    if (!matches_identity(&before, home_dev, home_ino)) {
      report_failure("proof home identity changed to a non-directory before removal: %s", home_name);
    }
    if (unlinkat(temp_fd, home_name, 0) != 0 && errno != ENOENT) {
      report_failure("could not unlink exact non-directory proof home %s: %s", home_name, strerror(errno));
      return 0;
    }
    return failures == 0;
  }
  if (!matches_identity(&before, home_dev, home_ino)) {
    report_failure("refusing to recurse into a replaced proof home directory: %s", home_name);
    return 0;
  }
  home_fd = open_pinned_directory(
    temp_fd, home_name, 1, home_dev, home_ino, "proof home", &opened
  );
  if (home_fd < 0) return 0;
  ok = remove_directory_children(home_fd, opened.st_dev, 0);
  if (close(home_fd) != 0) {
    report_failure("could not close proof home before removal: %s", strerror(errno));
    ok = 0;
  }
  if (!ok) return 0;
  if (fstatat(temp_fd, home_name, &current, AT_SYMLINK_NOFOLLOW) != 0) {
    if (errno == ENOENT) return failures == 0;
    report_failure("could not re-identify proof home before removal: %s", strerror(errno));
    return 0;
  }
  if (!same_identity(&opened, &current)) {
    report_failure("proof home entry changed before exact removal: %s", home_name);
    return 0;
  }
  if (unlinkat(temp_fd, home_name, AT_REMOVEDIR) != 0) {
    report_failure("could not remove exact proof home directory %s: %s", home_name, strerror(errno));
    return 0;
  }
  return failures == 0;
}

static int write_log(int temp_fd, const char *home_name, uint64_t home_dev, uint64_t home_ino) {
  static const char log_name[] = "proof-daemon.log";
  struct stat home_stats;
  struct stat opened;
  struct stat current;
  unsigned char buffer[64 * 1024];
  size_t total = 0;
  int home_fd = open_pinned_directory(
    temp_fd, home_name, 1, home_dev, home_ino, "proof home", &home_stats
  );
  int log_fd;
  int complete = 0;
  int opened_pinned = 0;
  if (home_fd < 0) return 0;
  log_fd = openat(
    home_fd,
    log_name,
    O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC,
    0600
  );
  if (log_fd < 0) {
    report_failure("could not create exact proof daemon log: %s", strerror(errno));
    close(home_fd);
    return 0;
  }
  if (fchmod(log_fd, 0600) != 0) {
    report_failure("proof daemon log could not be forced to mode 0600: %s", strerror(errno));
    goto cleanup;
  }
  if (fstat(log_fd, &opened) != 0 || !S_ISREG(opened.st_mode)) {
    report_failure("proof daemon log descriptor is not a regular file");
    goto cleanup;
  }
  opened_pinned = 1;
  for (;;) {
    ssize_t count = read(STDIN_FILENO, buffer, sizeof(buffer));
    size_t offset = 0;
    if (count == 0) break;
    if (count < 0) {
      if (errno == EINTR) continue;
      report_failure("could not read bounded proof daemon log input: %s", strerror(errno));
      goto cleanup;
    }
    if (total + (size_t)count > MAX_LOG_BYTES) {
      report_failure("proof daemon log input exceeds the native %d-byte bound", MAX_LOG_BYTES);
      goto cleanup;
    }
    while (offset < (size_t)count) {
      ssize_t written = write(log_fd, buffer + offset, (size_t)count - offset);
      if (written < 0 && errno == EINTR) continue;
      if (written <= 0) {
        report_failure("could not persist bounded proof daemon log: %s", strerror(errno));
        goto cleanup;
      }
      offset += (size_t)written;
    }
    total += (size_t)count;
  }
  if (fsync(log_fd) != 0) {
    report_failure("could not fsync bounded proof daemon log: %s", strerror(errno));
    goto cleanup;
  }
  complete = 1;

cleanup:
  if (close(log_fd) != 0 && complete) {
    report_failure("could not close bounded proof daemon log: %s", strerror(errno));
    complete = 0;
  }
  if (!complete) {
    if (opened_pinned
        && fstatat(home_fd, log_name, &current, AT_SYMLINK_NOFOLLOW) == 0
        && same_identity(&opened, &current)) {
      if (unlinkat(home_fd, log_name, 0) != 0) {
        report_failure("could not remove incomplete proof daemon log: %s", strerror(errno));
      }
    }
  } else if (fstatat(home_fd, log_name, &current, AT_SYMLINK_NOFOLLOW) != 0
      || !S_ISREG(current.st_mode) || !same_identity(&opened, &current)) {
    report_failure("proof daemon log identity changed after persistence: %s/%s", home_name, log_name);
  }
  verify_directory_entry(temp_fd, home_name, &home_stats, "proof home");
  close(home_fd);
  return complete && failures == 0;
}

int main(int argc, char **argv) {
  struct stat temp_stats;
  int temp_fd;
  int ok = 0;

  (void)argv;
  if (argc != 1) {
    fputs("proof-fs: this executable has no command-line authority\n", stderr);
    return 64;
  }
  if (PROOF_BOUND_TEMP_ROOT[0] != '/') {
    fputs("proof-fs: refusing non-absolute bound temp root\n", stderr);
    return 64;
  }
  if (strcmp(PROOF_BOUND_OPERATION, "selftest") != 0
      && !valid_home_name(PROOF_BOUND_HOME_NAME)) {
    fputs("proof-fs: invalid bound proof-home basename\n", stderr);
    return 64;
  }

  temp_fd = open(PROOF_BOUND_TEMP_ROOT, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (temp_fd < 0) {
    fprintf(stderr, "proof-fs: could not open real temp root without following links: %s\n", strerror(errno));
    return 1;
  }
  if (fstat(temp_fd, &temp_stats) != 0
      || !S_ISDIR(temp_stats.st_mode)
      || !matches_identity(
        &temp_stats,
        (uint64_t)PROOF_BOUND_TEMP_DEVICE,
        (uint64_t)PROOF_BOUND_TEMP_INODE
      )) {
    fputs("proof-fs: bound real temp root identity changed\n", stderr);
    close(temp_fd);
    return 1;
  }

  if (strcmp(PROOF_BOUND_OPERATION, "selftest") == 0) {
    ok = 1;
  } else if (strcmp(PROOF_BOUND_OPERATION, "release") == 0) {
    ok = release_reserve(
      temp_fd,
      PROOF_BOUND_HOME_NAME,
      (uint64_t)PROOF_BOUND_HOME_DEVICE,
      (uint64_t)PROOF_BOUND_HOME_INODE
    );
  } else if (strcmp(PROOF_BOUND_OPERATION, "sanitize") == 0) {
    ok = sanitize_home(
      temp_fd,
      PROOF_BOUND_HOME_NAME,
      (uint64_t)PROOF_BOUND_HOME_DEVICE,
      (uint64_t)PROOF_BOUND_HOME_INODE,
      PROOF_BOUND_ENFORCE_STATE,
      (uint64_t)PROOF_BOUND_STATE_DEVICE,
      (uint64_t)PROOF_BOUND_STATE_INODE
    );
  } else if (strcmp(PROOF_BOUND_OPERATION, "remove") == 0) {
    ok = remove_home(
      temp_fd,
      PROOF_BOUND_HOME_NAME,
      (uint64_t)PROOF_BOUND_HOME_DEVICE,
      (uint64_t)PROOF_BOUND_HOME_INODE
    );
  } else if (strcmp(PROOF_BOUND_OPERATION, "write-log") == 0) {
    ok = write_log(
      temp_fd,
      PROOF_BOUND_HOME_NAME,
      (uint64_t)PROOF_BOUND_HOME_DEVICE,
      (uint64_t)PROOF_BOUND_HOME_INODE
    );
  } else {
    fputs("proof-fs: unsupported bound operation\n", stderr);
    close(temp_fd);
    return 64;
  }
  close(temp_fd);
  return ok && failures == 0 ? 0 : 1;
}
