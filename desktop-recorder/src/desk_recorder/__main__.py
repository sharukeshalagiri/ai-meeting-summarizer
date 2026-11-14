"""Entry point: `python -m desk_recorder` (or the PyInstaller exe).

--fake-audio records synthetic tones instead of devices, to try the tray
and the upload path without capturing anything real.
"""

from __future__ import annotations

import argparse
import logging
import logging.handlers

from desk_recorder import __version__
from desk_recorder.config import app_dir


def main() -> None:
    parser = argparse.ArgumentParser(prog="desk_recorder")
    parser.add_argument("--fake-audio", action="store_true", help="record synthetic tones")
    parser.add_argument("--version", action="version", version=__version__)
    args = parser.parse_args()

    app_dir().mkdir(parents=True, exist_ok=True)
    handler = logging.handlers.RotatingFileHandler(
        app_dir() / "recorder.log", maxBytes=1_000_000, backupCount=2, encoding="utf-8")
    logging.basicConfig(level=logging.INFO, handlers=[handler, logging.StreamHandler()],
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")

    # Imported here so --version / --help work without a display.
    from desk_recorder.audio import create_source
    from desk_recorder.controller import Controller
    from desk_recorder.tray import TrayApp

    factory = (lambda s: create_source(fake=True)) if args.fake_audio else None
    TrayApp(Controller(source_factory=factory)).run()


if __name__ == "__main__":
    main()
