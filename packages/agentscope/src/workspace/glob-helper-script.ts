/** Standalone Python helper bundled into remote workspace images. */
export const GLOB_HELPER_PYTHON_SCRIPT = `#!/usr/bin/env python3
import argparse
import glob
import json
import os


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pattern", required=True)
    parser.add_argument("--base-dir", required=True)
    args = parser.parse_args()
    if not os.path.isdir(args.base_dir):
        print("[]", end="")
        return
    pattern = os.path.join(args.base_dir, args.pattern)
    matches = [
        value
        for value in glob.glob(pattern, recursive=True)
        if os.path.isfile(value)
    ]
    matches.sort(
        key=lambda value: os.path.getmtime(value)
        if os.path.exists(value)
        else 0.0,
        reverse=True,
    )
    json.dump(matches, sys.stdout)


if __name__ == "__main__":
    import sys
    main()
`;
