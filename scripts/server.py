from __future__ import annotations

import hashlib
import hmac
import json
import math
import os
import re
import secrets
import ssl
import sqlite3
import sys
import threading
import time
from contextlib import closing, contextmanager
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import URLError
from urllib.parse import parse_qs, urlencode, urlsplit, unquote
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
DATA_PATH = ROOT / "data" / "dawaey-data.json"
DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
DATABASE_PATH = Path(os.environ.get("DAWAEY_DATABASE", ROOT / "data" / "dawaey-users.sqlite3"))
SESSION_COOKIE = "dawaey_session"
SESSION_SECONDS = 60 * 60 * 24 * 14
PBKDF2_ITERATIONS = 310_000
GEOCODE_LOCK = threading.Lock()
LAST_GEOCODE_REQUEST = 0.0


def db_execute(connection, query: str, params: tuple = ()):
    if DATABASE_URL:
        return connection.cursor().execute(query.replace("?", "%s"), params)
    return connection.execute(query, params)


def connect_database():
    if DATABASE_URL:
        try:
            import pymysql
        except ImportError as error:
            raise RuntimeError("PyMySQL is required when DATABASE_URL is configured.") from error
        parsed = urlsplit(DATABASE_URL)
        database = parsed.path.lstrip("/")
        if not parsed.hostname or not database:
            raise RuntimeError("DATABASE_URL is not a valid MySQL connection URL.")
        return pymysql.connect(
            host=parsed.hostname,
            port=parsed.port or 3306,
            user=unquote(parsed.username or ""),
            password=unquote(parsed.password or ""),
            database=database,
            cursorclass=pymysql.cursors.DictCursor,
            autocommit=False,
            ssl=ssl.create_default_context(),
            connect_timeout=10,
        )
    import sqlite3
    connection = sqlite3.connect(DATABASE_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


@contextmanager
def database_connection():
    connection = connect_database()
    try:
        with connection:
            yield connection
    finally:
        if getattr(connection, "open", True):
            connection.close()


def initialize_database() -> None:
    with database_connection() as connection:
        if DATABASE_URL:
            statements = (
                "CREATE TABLE IF NOT EXISTS accounts (id BIGINT PRIMARY KEY AUTO_INCREMENT, role VARCHAR(20) NOT NULL, full_name VARCHAR(100) NOT NULL, contact VARCHAR(255) NOT NULL, contact_key VARCHAR(255) NOT NULL UNIQUE, password_salt VARCHAR(64) NOT NULL, password_hash VARCHAR(128) NOT NULL, created_at BIGINT NOT NULL)",
                "CREATE TABLE IF NOT EXISTS patient_profiles (account_id BIGINT PRIMARY KEY, governorate VARCHAR(120) NOT NULL, district VARCHAR(160) NOT NULL, CONSTRAINT fk_patient_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE)",
                "CREATE TABLE IF NOT EXISTS pharmacy_applications (account_id BIGINT PRIMARY KEY, pharmacy_name VARCHAR(120) NOT NULL, pharmacist_name VARCHAR(120) NOT NULL, license_number VARCHAR(64) NOT NULL UNIQUE, address VARCHAR(240) NOT NULL, district VARCHAR(160) NOT NULL, opening_hours VARCHAR(160) NOT NULL, whatsapp VARCHAR(40) NOT NULL, status VARCHAR(20) NOT NULL DEFAULT 'pending', CONSTRAINT fk_pharmacy_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE)",
                "CREATE TABLE IF NOT EXISTS sessions (token_hash VARCHAR(128) PRIMARY KEY, account_id BIGINT NOT NULL, expires_at BIGINT NOT NULL, CONSTRAINT fk_session_account FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE)",
            )
            for statement in statements:
                db_execute(connection, statement)
            return
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                role TEXT NOT NULL CHECK(role IN ('patient', 'pharmacy')),
                full_name TEXT NOT NULL,
                contact TEXT NOT NULL,
                contact_key TEXT NOT NULL UNIQUE,
                password_salt TEXT NOT NULL,
                password_hash TEXT NOT NULL,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS patient_profiles (
                account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
                governorate TEXT NOT NULL,
                district TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS pharmacy_applications (
                account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
                pharmacy_name TEXT NOT NULL,
                pharmacist_name TEXT NOT NULL,
                license_number TEXT NOT NULL UNIQUE,
                address TEXT NOT NULL,
                district TEXT NOT NULL,
                opening_hours TEXT NOT NULL,
                whatsapp TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected'))
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token_hash TEXT PRIMARY KEY,
                account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
                expires_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
            """
        )


def normalize_contact(value: object) -> tuple[str, str]:
    contact = str(value or "").strip()
    if "@" in contact:
        normalized = contact.casefold()
        if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", normalized):
            raise ValueError("اكتب بريد إلكتروني صحيح أو رقم موبايل.")
        return contact, normalized

    digits = re.sub(r"\D", "", contact)
    if not 8 <= len(digits) <= 15:
        raise ValueError("اكتب رقم موبايل صحيح.")
    return contact, digits


def password_digest(password: str, salt: bytes) -> bytes:
    return hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITERATIONS)


def create_session(connection: sqlite3.Connection, account_id: int) -> str:
    token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(token.encode("ascii")).hexdigest()
    db_execute(connection, 
        "INSERT INTO sessions(token_hash, account_id, expires_at) VALUES (?, ?, ?)",
        (token_hash, account_id, int(time.time()) + SESSION_SECONDS),
    )
    return token


def public_account(connection: sqlite3.Connection, account: sqlite3.Row) -> dict:
    result = {
        "id": account["id"],
        "role": account["role"],
        "name": account["full_name"],
        "contact": account["contact"],
    }
    if account["role"] == "pharmacy":
        application = db_execute(connection, 
            "SELECT pharmacy_name, status FROM pharmacy_applications WHERE account_id = ?",
            (account["id"],),
        ).fetchone()
        if application:
            result["pharmacyName"] = application["pharmacy_name"]
            result["status"] = application["status"]
    return result


class DawaeyHandler(SimpleHTTPRequestHandler):
    server_version = "DawaeyLocal/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def send_json(self, status: int, payload: dict, cookie: str | None = None) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def read_json(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as error:
            raise ValueError("تعذر قراءة الطلب.") from error
        if length < 1 or length > 64_000:
            raise ValueError("حجم الطلب غير صالح.")
        try:
            payload = json.loads(self.rfile.read(length))
        except (json.JSONDecodeError, UnicodeDecodeError) as error:
            raise ValueError("بيانات النموذج غير صالحة.") from error
        if not isinstance(payload, dict):
            raise ValueError("بيانات النموذج غير صالحة.")
        return payload

    def verify_origin(self) -> bool:
        origin = self.headers.get("Origin")
        return not origin or urlsplit(origin).netloc == self.headers.get("Host")

    def get_session_token(self) -> str | None:
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except Exception:
            return None
        morsel = cookie.get(SESSION_COOKIE)
        return morsel.value if morsel else None

    def do_GET(self) -> None:
        route = urlsplit(self.path).path
        if route == "/healthz":
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(b"ok")
            return
        if route.startswith("/data/") or route.startswith("/scripts/"):
            self.send_error(404)
            return
        if route == "/api/bootstrap":
            self.handle_bootstrap()
            return
        if route == "/api/area":
            self.handle_area()
            return
        if route == "/api/session":
            self.handle_session()
            return
        super().do_GET()

    def do_HEAD(self) -> None:
        route = urlsplit(self.path).path
        if route.startswith("/data/") or route.startswith("/scripts/"):
            self.send_error(404)
            return
        super().do_HEAD()

    def do_POST(self) -> None:
        route = urlsplit(self.path).path
        if not route.startswith("/api/"):
            self.send_error(404)
            return
        if not self.verify_origin():
            self.send_json(403, {"error": "الطلب غير مسموح."})
            return
        try:
            payload = self.read_json() if route in ("/api/register", "/api/login") else {}
            if route == "/api/register":
                self.handle_register(payload)
            elif route == "/api/login":
                self.handle_login(payload)
            elif route == "/api/logout":
                self.handle_logout()
            else:
                self.send_json(404, {"error": "المسار غير موجود."})
        except ValueError as error:
            self.send_json(400, {"error": str(error)})
        except Exception as error:
            integrity_types = (sqlite3.IntegrityError,)
            try:
                import pymysql
            except ImportError:
                pass
            else:
                integrity_types += (pymysql.err.IntegrityError,)
            if not isinstance(error, integrity_types):
                raise
            message = "رقم التواصل مسجل بالفعل. جرّب تسجيل الدخول."
            if "pharmacy_applications.license_number" in str(error):
                message = "رقم الترخيص مسجل بالفعل."
            self.send_json(409, {"error": message})

    def handle_bootstrap(self) -> None:
        try:
            workbook = json.loads(DATA_PATH.read_text(encoding="utf-8"))
            sheets = workbook["sheets"]
            inventory = sheets.get("الاصناف والكميات", [])
            supply = sheets.get("طلبات التوريد", [])
            pharmacies = sheets.get("بيانات الصيداليات", [])
            supply_by_number = {str(record.get("م")): record for record in supply}
            catalog = [
                {**item, **supply_by_number.get(str(item.get("م")), {})}
                for item in inventory
            ]
            self.send_json(200, {"source": workbook.get("source", ""), "catalog": catalog, "pharmacies": pharmacies, "sheets": sheets})
        except (OSError, json.JSONDecodeError, KeyError) as error:
            self.send_json(503, {"error": "بيانات المصدر غير متاحة حاليًا."})
            self.log_error("Could not load workbook data: %s", error)

    def handle_area(self) -> None:
        global LAST_GEOCODE_REQUEST
        parameters = parse_qs(urlsplit(self.path).query)
        try:
            latitude = float(parameters.get("lat", [""])[0])
            longitude = float(parameters.get("lon", [""])[0])
        except ValueError:
            self.send_json(400, {"error": "موقع جغرافي غير صالح."})
            return
        if not math.isfinite(latitude) or not math.isfinite(longitude) or not -90 <= latitude <= 90 or not -180 <= longitude <= 180:
            self.send_json(400, {"error": "موقع جغرافي غير صالح."})
            return

        with GEOCODE_LOCK:
            now = time.monotonic()
            if now - LAST_GEOCODE_REQUEST < 1:
                self.send_json(429, {"error": "استنى لحظة قبل محاولة تحديد المنطقة مرة تانية."})
                return
            LAST_GEOCODE_REQUEST = now

        query = urlencode({
            "lat": latitude,
            "lon": longitude,
            "format": "jsonv2",
            "zoom": 14,
            "addressdetails": 1,
            "accept-language": "ar",
        })
        request = Request(
            f"https://nominatim.openstreetmap.org/reverse?{query}",
            headers={"User-Agent": "DawaeyLocal/1.0", "Accept": "application/json"},
        )
        try:
            with urlopen(request, timeout=7) as response:
                place = json.loads(response.read().decode("utf-8"))
        except (OSError, URLError, TimeoutError, json.JSONDecodeError):
            self.send_json(503, {"error": "خدمة تحديد المنطقة غير متاحة؛ اكتب منطقتك يدويًا."})
            return

        address = place.get("address", {})
        area = next((address.get(key) for key in ("neighbourhood", "suburb", "city_district", "district", "town", "village", "hamlet") if address.get(key)), None)
        if not area:
            self.send_json(404, {"error": "ما قدرناش نحدد اسم المنطقة من موقعك."})
            return
        self.send_json(200, {"area": str(area), "attribution": "OpenStreetMap contributors"})

    def handle_register(self, payload: dict) -> None:
        role = str(payload.get("role", ""))
        if role not in {"patient", "pharmacy"}:
            raise ValueError("اختار نوع الحساب.")
        full_name = str(payload.get("fullName", "")).strip()
        if len(full_name) < 2 or len(full_name) > 100:
            raise ValueError("اكتب الاسم بشكل صحيح.")
        contact, contact_key = normalize_contact(payload.get("contact"))
        password = str(payload.get("password", ""))
        if not 8 <= len(password) <= 128:
            raise ValueError("كلمة المرور لازم تكون ٨ أحرف على الأقل.")
        if payload.get("privacyAccepted") is not True:
            raise ValueError("وافق على سياسة الخصوصية لإكمال التسجيل.")

        salt = secrets.token_bytes(16)
        encoded_salt = salt.hex()
        encoded_hash = password_digest(password, salt).hex()
        with database_connection() as connection:
            cursor = db_execute(connection, 
                "INSERT INTO accounts(role, full_name, contact, contact_key, password_salt, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (role, full_name, contact, contact_key, encoded_salt, encoded_hash, int(time.time())),
            )
            account_id = cursor.lastrowid
            if role == "patient":
                governorate = str(payload.get("governorate", "")).strip()
                district = str(payload.get("district", "")).strip()
                if not governorate or not district:
                    raise ValueError("اختار المحافظة والمنطقة.")
                db_execute(connection, 
                    "INSERT INTO patient_profiles(account_id, governorate, district) VALUES (?, ?, ?)",
                    (account_id, governorate, district),
                )
                token = create_session(connection, account_id)
                account = db_execute(connection, "SELECT * FROM accounts WHERE id = ?", (account_id,)).fetchone()
                cookie = self.session_cookie(token)
                self.send_json(201, {"user": public_account(connection, account)}, cookie)
                return

            pharmacy_name = str(payload.get("pharmacyName", "")).strip()
            pharmacist_name = str(payload.get("pharmacistName", "")).strip()
            license_number = str(payload.get("licenseNumber", "")).strip()
            address = str(payload.get("address", "")).strip()
            district = str(payload.get("district", "")).strip()
            opening_hours = str(payload.get("openingHours", "")).strip()
            whatsapp = str(payload.get("whatsapp", "")).strip()
            if not all((pharmacy_name, pharmacist_name, license_number, address, district, opening_hours, whatsapp)):
                raise ValueError("كمّل بيانات الصيدلية والصيدلي المسؤول والعنوان ومواعيد العمل.")
            if len(license_number) > 64 or len(pharmacy_name) > 120 or len(address) > 240:
                raise ValueError("راجع طول بيانات الصيدلية.")
            db_execute(connection, 
                "INSERT INTO pharmacy_applications(account_id, pharmacy_name, pharmacist_name, license_number, address, district, opening_hours, whatsapp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (account_id, pharmacy_name, pharmacist_name, license_number, address, district, opening_hours, whatsapp),
            )
        self.send_json(202, {"status": "pending", "message": "تم حفظ طلب الصيدلية. الحساب قيد المراجعة قبل تفعيله."})

    def handle_login(self, payload: dict) -> None:
        _, contact_key = normalize_contact(payload.get("contact"))
        password = str(payload.get("password", ""))
        role = str(payload.get("role", ""))
        with database_connection() as connection:
            account = db_execute(connection, "SELECT * FROM accounts WHERE contact_key = ?", (contact_key,)).fetchone()
            if not account or not hmac.compare_digest(
                bytes.fromhex(account["password_hash"]),
                password_digest(password, bytes.fromhex(account["password_salt"])),
            ):
                self.send_json(401, {"error": "بيانات الدخول مش صحيحة."})
                return
            if role and account["role"] != role:
                self.send_json(401, {"error": "نوع الحساب لا يطابق بيانات الدخول."})
                return
            if account["role"] == "pharmacy":
                application = db_execute(connection, 
                    "SELECT status FROM pharmacy_applications WHERE account_id = ?", (account["id"],)
                ).fetchone()
                if not application or application["status"] != "approved":
                    self.send_json(403, {"error": "طلب الصيدلية قيد المراجعة. هيتفعل الحساب بعد اعتماد البيانات."})
                    return
            token = create_session(connection, account["id"])
            self.send_json(200, {"user": public_account(connection, account)}, self.session_cookie(token))

    def handle_session(self) -> None:
        token = self.get_session_token()
        if not token:
            self.send_json(200, {"user": None})
            return
        token_hash = hashlib.sha256(token.encode("ascii", errors="ignore")).hexdigest()
        with database_connection() as connection:
            account = db_execute(connection, 
                "SELECT accounts.* FROM sessions JOIN accounts ON accounts.id = sessions.account_id WHERE sessions.token_hash = ? AND sessions.expires_at > ?",
                (token_hash, int(time.time())),
            ).fetchone()
            if not account:
                db_execute(connection, "DELETE FROM sessions WHERE token_hash = ?", (token_hash,))
                self.send_json(200, {"user": None}, self.expired_cookie())
                return
            self.send_json(200, {"user": public_account(connection, account)})

    def handle_logout(self) -> None:
        token = self.get_session_token()
        if token:
            token_hash = hashlib.sha256(token.encode("ascii", errors="ignore")).hexdigest()
            with database_connection() as connection:
                db_execute(connection, "DELETE FROM sessions WHERE token_hash = ?", (token_hash,))
        self.send_json(200, {"ok": True}, self.expired_cookie())

    @staticmethod
    def session_cookie(token: str) -> str:
        secure = os.environ.get("DAWAEY_SECURE_COOKIE") == "1"
        same_site = "None" if secure else "Lax"
        suffix = "; Secure" if secure else ""
        return f"{SESSION_COOKIE}={token}; HttpOnly; SameSite={same_site}; Path=/; Max-Age={SESSION_SECONDS}{suffix}"

    @staticmethod
    def expired_cookie() -> str:
        secure = os.environ.get("DAWAEY_SECURE_COOKIE") == "1"
        same_site = "None" if secure else "Lax"
        suffix = "; Secure" if secure else ""
        return f"{SESSION_COOKIE}=; HttpOnly; SameSite={same_site}; Path=/; Max-Age=0{suffix}"


def main() -> None:
    if not DATA_PATH.exists():
        raise FileNotFoundError(f"Missing published dataset: {DATA_PATH}")
    print("Dawaey published dataset loaded")
    initialize_database()
    port = int(os.environ.get("PORT", "5173"))
    server = ThreadingHTTPServer(("", port), DawaeyHandler)
    print(f"Dawaey server listening on http://localhost:{port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nDawaey server stopped")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
