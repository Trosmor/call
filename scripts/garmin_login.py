"""
Run this ONCE, on your own machine, to create a Garmin Connect session token.

This never sends your email/password anywhere except Garmin's own servers —
it talks to Garmin directly via the garminconnect library. The output is a
token store directory that you then base64-encode and paste into a GitHub
Actions secret, so the daily sync workflow never needs your real password.

Usage:
    pip install garminconnect
    python scripts/garmin_login.py

Handles MFA (the 6-digit code Garmin emails/texts you) if your account has it enabled.
"""
import getpass
import sys
from pathlib import Path

try:
    from garminconnect import Garmin
except ImportError:
    print("Missing dependency. Run: pip install garminconnect", file=sys.stderr)
    sys.exit(1)

TOKEN_STORE = str(Path("~/.garminconnect").expanduser())


def main():
    email = input("Garmin email: ").strip()
    password = getpass.getpass("Garmin password: ")

    client = Garmin(
        email=email,
        password=password,
        prompt_mfa=lambda: input("MFA code (check email/SMS): ").strip(),
    )
    client.login(TOKEN_STORE)

    print(f"\nLogin successful. Tokens saved to: {TOKEN_STORE}")
    print("\nNext step — package this folder for GitHub Actions:")
    if sys.platform.startswith("win"):
        print(f'  Compress-Archive -Path "{TOKEN_STORE}\\*" -DestinationPath garmin_tokens.zip')
        print("  certutil -encode garmin_tokens.zip garmin_tokens_b64.txt")
    else:
        print(f"  cd {TOKEN_STORE} && zip -r ~/garmin_tokens.zip . && cd -")
        print("  base64 -i ~/garmin_tokens.zip -o ~/garmin_tokens_b64.txt")
    print("\nThen copy the contents of that base64 file into a GitHub Actions secret")
    print("named GARMIN_TOKENSTORE_B64 (repo Settings > Secrets and variables > Actions).")


if __name__ == "__main__":
    main()
