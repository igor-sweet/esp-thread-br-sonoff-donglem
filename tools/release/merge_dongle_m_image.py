#!/usr/bin/env python3
"""Build Dongle-M ESP32 images from ESP-IDF metadata.

Produces two images:
- a factory image, flashed at 0x0, that replaces everything including NVS (Thread network, Wi-Fi);
- an update image, flashed at the application offset, that keeps the bootloader, partition table,
  NVS and OTA data untouched.
"""

import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path


def merge(chip, output, image_args, settings=None, target_offset=None):
    output.parent.mkdir(parents=True, exist_ok=True)
    command = [sys.executable, "-m", "esptool", "--chip", chip, "merge_bin", "--output", str(output)]
    if target_offset is not None:
        command.extend(["--target-offset", hex(target_offset)])
    for key in ("flash_mode", "flash_freq", "flash_size"):
        if settings and key in settings:
            command.extend([f"--{key}", settings[key]])
    command.extend(image_args)
    sys.stdout.flush()
    subprocess.run(command, check=True)

    digest = hashlib.sha256(output.read_bytes()).hexdigest()
    checksum_path = output.with_name(output.name + ".sha256")
    checksum_path.write_text(f"{digest}  {output.name}\n", encoding="utf-8")
    print("SHA-256:", digest)
    print("Checksum:", checksum_path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("build_dir", type=Path, help="ESP-IDF build directory containing flasher_args.json")
    parser.add_argument("--output", type=Path, help="factory output path (default: build_dir/sonoff-dongle-m-otbr.bin)")
    parser.add_argument("--update-output", type=Path,
                        help="update output path (default: factory output name with an -update suffix)")
    args = parser.parse_args()

    build_dir = args.build_dir.resolve()
    metadata_path = build_dir / "flasher_args.json"
    if not metadata_path.is_file():
        parser.error(f"missing ESP-IDF flash metadata: {metadata_path}")

    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    flash_files = metadata.get("flash_files", {})
    if not flash_files:
        parser.error(f"flash metadata has no flash_files: {metadata_path}")
    app_offset = metadata.get("app", {}).get("offset")
    if not app_offset:
        parser.error(f"flash metadata has no application offset: {metadata_path}")
    app_offset = int(app_offset, 0)

    factory_args = []
    update_args = []
    for address, relative_name in sorted(flash_files.items(), key=lambda item: int(item[0], 0)):
        image_path = build_dir / relative_name
        if not image_path.is_file():
            parser.error(f"flash image listed by metadata does not exist: {image_path}")
        if "rcp" in image_path.name.lower():
            parser.error(f"refusing to package an RCP image: {image_path.name}")
        factory_args.extend([address, str(image_path)])
        # Everything below the application (bootloader, partition table, NVS, OTA data) stays on the device.
        if int(address, 0) >= app_offset:
            update_args.extend([address, str(image_path)])

    chip = metadata.get("extra_esptool_args", {}).get("chip", "esp32")
    output = (args.output or build_dir / "sonoff-dongle-m-otbr.bin").resolve()
    update_output = (args.update_output or output.with_name(f"{output.stem}-update{output.suffix}")).resolve()

    print("Using ESP-IDF flash metadata:", metadata_path)
    print("Merging factory image (flash at 0x0) to:", output)
    merge(chip, output, factory_args, settings=metadata.get("flash_settings", {}))
    print(f"Merging update image (flash at {hex(app_offset)}) to:", update_output)
    merge(chip, update_output, update_args, target_offset=app_offset)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
