"""Claude Code IDE — Backup System

Creates local zip snapshots and pushes data to a private GitHub repo.

Usage:
    python backup.py              # Run backup (called by start-ide.bat)
    python backup.py --restore    # List available backups
    python backup.py --restore N  # Restore from backup N
"""

import argparse
import os
import shutil
import subprocess
import sys
import zipfile
from datetime import datetime
from pathlib import Path

# Paths
IDE_DIR = Path(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = IDE_DIR / "data"
BACKUPS_DIR = IDE_DIR / "backups"
BACKUP_REPO = IDE_DIR.parent / "Claude-Code-IDE-Backups"

MAX_LOCAL_BACKUPS = 10


def log(msg):
    print(f"[BACKUP] {msg}")


def create_local_zip():
    """Create a timestamped zip of the data/ directory."""
    BACKUPS_DIR.mkdir(exist_ok=True)
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    zip_name = f"data_backup_{timestamp}.zip"
    zip_path = BACKUPS_DIR / zip_name

    log(f"Creating local zip: {zip_name}")
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, dirs, files in os.walk(DATA_DIR):
            for file in files:
                file_path = Path(root) / file
                arc_name = file_path.relative_to(IDE_DIR)
                zf.write(file_path, arc_name)

    size_mb = zip_path.stat().st_size / (1024 * 1024)
    log(f"  Saved: {zip_path} ({size_mb:.1f} MB)")
    return zip_path


def prune_local_backups():
    """Keep only the most recent N local zip backups."""
    if not BACKUPS_DIR.exists():
        return

    zips = sorted(BACKUPS_DIR.glob("data_backup_*.zip"))
    if len(zips) <= MAX_LOCAL_BACKUPS:
        return

    to_delete = zips[: len(zips) - MAX_LOCAL_BACKUPS]
    for zp in to_delete:
        zp.unlink()
        log(f"  Pruned old backup: {zp.name}")


def git_push_backup():
    """Mirror data/ to the backup git repo and push."""
    if not BACKUP_REPO.exists():
        log(f"WARNING: Backup repo not found at {BACKUP_REPO}")
        log("  Run: git clone https://github.com/Powellga/claude-code-ide-backups.git")
        log(f"  Into: {BACKUP_REPO.parent}")
        return False

    dest_data = BACKUP_REPO / "data"

    # Mirror data/ to backup repo using robocopy (Windows) or rsync
    log("Syncing data/ to backup repo...")
    if sys.platform == "win32":
        # robocopy /MIR mirrors source to dest, returns 0-7 on success
        result = subprocess.run(
            ["robocopy", str(DATA_DIR), str(dest_data), "/MIR", "/NFL", "/NDL", "/NJH", "/NJS", "/NP"],
            capture_output=True, text=True
        )
        # robocopy returns 0-7 for success, 8+ for errors
        if result.returncode >= 8:
            log(f"  Robocopy error (code {result.returncode}): {result.stderr}")
            return False
    else:
        subprocess.run(["rsync", "-a", "--delete", f"{DATA_DIR}/", f"{dest_data}/"], check=True)

    # Git add, commit, push
    def git(*args):
        return subprocess.run(
            ["git"] + list(args),
            cwd=str(BACKUP_REPO),
            capture_output=True, text=True
        )

    git("add", "-A")

    # Check if there are changes to commit
    status = git("status", "--porcelain")
    if not status.stdout.strip():
        log("  No changes since last backup")
        return True

    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    commit_msg = f"Backup {timestamp}"
    git("commit", "-m", commit_msg)

    log("Pushing to GitHub...")
    result = git("push", "origin", "main")
    if result.returncode != 0:
        # Try master branch
        result = git("push", "origin", "master")
        if result.returncode != 0:
            # Might be first push — set upstream
            result = git("push", "-u", "origin", "HEAD")
            if result.returncode != 0:
                log(f"  Push failed: {result.stderr}")
                return False

    log("  Pushed to GitHub successfully")
    return True


def list_backups():
    """List available local zip backups."""
    if not BACKUPS_DIR.exists():
        print("No local backups found.")
        return []

    zips = sorted(BACKUPS_DIR.glob("data_backup_*.zip"), reverse=True)
    if not zips:
        print("No local backups found.")
        return []

    print(f"\nAvailable backups ({len(zips)}):\n")
    for i, zp in enumerate(zips):
        size_mb = zp.stat().st_size / (1024 * 1024)
        # Parse timestamp from filename
        ts = zp.stem.replace("data_backup_", "")
        try:
            dt = datetime.strptime(ts, "%Y%m%d_%H%M%S")
            date_str = dt.strftime("%Y-%m-%d %H:%M:%S")
        except ValueError:
            date_str = ts
        print(f"  [{i}] {date_str}  ({size_mb:.1f} MB)  {zp.name}")

    return zips


def restore_backup(index):
    """Restore data/ from a local zip backup."""
    zips = sorted(BACKUPS_DIR.glob("data_backup_*.zip"), reverse=True)
    if not zips:
        print("No backups to restore from.")
        return

    if index < 0 or index >= len(zips):
        print(f"Invalid index. Choose 0-{len(zips) - 1}")
        return

    zip_path = zips[index]
    print(f"\nRestoring from: {zip_path.name}")
    print(f"This will REPLACE the current data/ directory.")
    confirm = input("Type 'yes' to confirm: ")

    if confirm.lower() != "yes":
        print("Cancelled.")
        return

    # Backup current data before restoring (safety net)
    safety_backup = BACKUPS_DIR / "pre_restore_safety.zip"
    print(f"Safety backup of current data -> {safety_backup.name}")
    with zipfile.ZipFile(safety_backup, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, dirs, files in os.walk(DATA_DIR):
            for file in files:
                fp = Path(root) / file
                zf.write(fp, fp.relative_to(IDE_DIR))

    # Clear and restore
    shutil.rmtree(DATA_DIR)
    print("Extracting backup...")
    with zipfile.ZipFile(zip_path, "r") as zf:
        zf.extractall(IDE_DIR)

    print("Restore complete. Restart the IDE server.")


def run_backup():
    """Run the full backup process."""
    log("Starting backup...")
    start = datetime.now()

    if not DATA_DIR.exists():
        log("No data/ directory found — nothing to back up")
        return

    create_local_zip()
    prune_local_backups()
    git_push_backup()

    elapsed = (datetime.now() - start).total_seconds()
    log(f"Backup complete in {elapsed:.1f}s")


def main():
    parser = argparse.ArgumentParser(description="Claude Code IDE Backup System")
    parser.add_argument(
        "--restore",
        nargs="?",
        const=-1,
        type=int,
        help="List backups, or restore from index N",
    )
    args = parser.parse_args()

    if args.restore is not None:
        if args.restore == -1:
            list_backups()
        else:
            restore_backup(args.restore)
    else:
        run_backup()


if __name__ == "__main__":
    main()
