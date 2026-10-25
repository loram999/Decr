from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import random
import re
import secrets
import sys
import urllib3
from typing import Any, Mapping, Optional

import requests
import curl_cffi.requests as curl_requests

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.padding import PKCS7

from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, ReplyKeyboardMarkup, KeyboardButton
from telegram.ext import ApplicationBuilder, ContextTypes, CommandHandler, MessageHandler, filters, CallbackQueryHandler

try:
    from PIL import Image
    import pytesseract
    OCR_OK = True
except ImportError:
    OCR_OK = False

# --- Configuration & Setup ---
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
logging.basicConfig(
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    level=logging.INFO,
    handlers=[logging.StreamHandler(sys.stdout)]
)
logger = logging.getLogger("WaveBot")
logging.getLogger("httpx").setLevel(logging.WARNING)

TOKEN = "8950400071:AAElBLKypLuM0yChLlA3evIlLKLXaNjpvXk"
ADMIN_ID = 8353748526
HOST = "https://api.wavemoney.io:8100"
WMT_MFS_HEADER = "wmt-mfs"
FINGERPRINT = "87EC104C0FFBB8E749CD59D9C64851441B38D1C13C9746DC124BB9E71E66DCB9"
APP_ID = "mm.com.wavemoney.wavepay"
USER_LANGUAGE = "en"
ACCEPT_ENCODING = "gzip, deflate, br"
VERSION_CODE = "1470"
APP_VERSION = "2.6.1"
DEFAULT_DEVICE = ""
DEFAULT_PRODUCT = "redfin"
DEFAULT_CPU_ABI = "arm64-v8a,armeabi-v7a,armeabi"
DEFAULT_MANUFACTURER = "Google"
REQUEST_TIMEOUT_SECONDS = 60

ACCOUNTS_FILE = "accounts.json"
USERS_FILE = "users.json"
USED_RECEIPTS_FILE = "used_receipts.json"

RSA_PUBLIC_KEY_1 = """-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA4fV3EhdFo6O6ujXcji4y
6GmhX8eXP6Of0SJSVp4AVQXj9Bbb5UKW0smu/wVhqBOSBpF9dfaJcCAhXOr9XDm5
aGZVEMQIJ1UM89MgYcvZ11zQ6z8mbq775X/8TUPun1L2Z+2oIc6fu5v0VKfjFo1J
2tuK+abF9C7EOcWClyAZFpo2GB+AYk3AcGTLJ8PcbH5A8KZesBVIitYb1uSASREJ
mvbeBSOyITpnLppXOui6RIba7Kc5KPvSJxJ270+SJxrg2t6CehoDAx1JW17q1VfC
OMVWewfwge8EkQ0DVwNy7p5z6a+1BoIEdweJn83/XluyMx6sWlbnwIJvc0i6vPTX
lwIDAQAB
-----END PUBLIC KEY-----"""

RSA_PUBLIC_KEY = """-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyVd3HpGdUJSJ+PMes20w
IPP0QTCTiiaMwldFnLWp8xi0hD5yY0ZXAkBYebDUQoxSCq2lSTNzI0PCHg48tOOA
c2QIB0/n/xhcr6UBIaXUVCjAiDa9NjEQ3DBs2eS9/MsTzHM4rj73+/XHK04XIUKE
upqpXSgeslanGWzu3I7HqVNPVLf2uCJ7TpCNhRCEMjOaKnteQRczTysjeZ/NaFr
zV4H1PMZClJxRUxcvWuORX1h/hmSAIYweJr9UL5xWKSnTYlR6FLLJRwIDGt9EjQF
9l15hT3kNxPPgRakfCv5sXOrALqxXQKy83m1WeR0MVvbSUx7Ct6N97M51lkQEcbw
VwIDAQAB
-----END PUBLIC KEY-----"""

def _rsa_encrypt_pkcs1v15(plaintext: str, public_pem: str) -> str:
    key = serialization.load_pem_public_key(public_pem.encode("ascii"))
    encrypted = key.encrypt(plaintext.encode("utf-8"), padding.PKCS1v15())
    return base64.b64encode(encrypted).decode("ascii")

def _aes_key(uid: str) -> bytes:
    return hashlib.sha1(uid.encode("utf-8")).digest()[:16]

def _aes_cbc_encrypt(plaintext: str, key: bytes, iv: bytes) -> bytes:
    padder = PKCS7(algorithms.AES.block_size).padder()
    padded = padder.update(plaintext.encode("utf-8")) + padder.finalize()
    encryptor = Cipher(algorithms.AES(key), modes.CBC(iv)).encryptor()
    return encryptor.update(padded) + encryptor.finalize()

def _aes_cbc_decrypt(ciphertext: bytes, key: bytes, iv: bytes) -> str:
    decryptor = Cipher(algorithms.AES(key), modes.CBC(iv)).decryptor()
    padded = decryptor.update(ciphertext) + decryptor.finalize()
    unpadder = PKCS7(algorithms.AES.block_size).unpadder()
    return (unpadder.update(padded) + unpadder.finalize()).decode("utf-8")

class WaveWallet:
    def __init__(self, *, phone: str, device_id: str, model: str, os_version: str, wmt_mfs: str = ""):
        self.base = HOST.rstrip("/")
        self.phone = phone
        self.device_id = device_id
        self.model = model
        self.os_version = os_version
        self.wmt_mfs = wmt_mfs
        self.timeout = REQUEST_TIMEOUT_SECONDS
        self.session = requests.Session()

    def _headers(self) -> dict[str, str]:
        return {
            "fingerprint": FINGERPRINT,
            "appId": APP_ID,
            "userLanguage": USER_LANGUAGE,
            "accept-encoding": ACCEPT_ENCODING,
            "versionCode": VERSION_CODE,
            "appVersion": APP_VERSION,
            "deviceId": self.device_id,
            "device": f"{self.model}({self.model})",
            "product": DEFAULT_PRODUCT,
            "cpuAbi": DEFAULT_CPU_ABI,
            "manufacturer": DEFAULT_MANUFACTURER,
            "model": self.model,
            "osVersion": self.os_version,
            "user-agent": "okhttp/4.9.0",
            WMT_MFS_HEADER: self.wmt_mfs,
        }

    def _request(self, method: str, path: str, **kwargs) -> requests.Response:
        url = f"{self.base}/{path.lstrip('/')}"
        headers = self._headers()
        headers.update(kwargs.pop("headers", {}))
        logger.info(f"API Request: {method} {path}")
        try:
            response = self.session.request(method, url, headers=headers, timeout=self.timeout, verify=False, **kwargs)
            logger.info(f"API Response: {response.status_code} - {response.text[:200]}")
            
            new_token = response.headers.get(WMT_MFS_HEADER)
            if new_token and new_token != self.wmt_mfs:
                self.wmt_mfs = new_token
                accounts = load_json(ACCOUNTS_FILE, [])
                for a in accounts:
                    if a["phone"] == self.phone:
                        a["wmt_mfs"] = new_token
                save_json(ACCOUNTS_FILE, accounts)
                
            return response
        except Exception as e:
            logger.error(f"API Error: {e}")
            raise e

    def request_otp(self) -> requests.Response:
        return self._request("GET", "v3/wmt-mfs-otp/generate-otp", params={"msisdn": self.phone})

    def confirm_otp(self, otp: str) -> requests.Response:
        return self._request("POST", "v3/wmt-mfs-otp/confirm-otp", data={"msisdn": self.phone, "otp": otp})

    def security_token(self) -> str:
        res = self._request("GET", "v3/wmt-mfs-otp/security-token", params={"msisdn": self.phone}, headers={"user-agent": "Dart/3.6.0 (dart:io)"})
        try:
            return str(res.json().get("responseMap", {}).get("securityCounter", ""))
        except:
            return ""

    def wallet_balance(self) -> float:
        res = self._request("GET", "v2/mfs-customer/wallet-balance")
        if res.status_code == 200:
            try: return float(res.json().get("responseMap", {}).get("balance", 0))
            except: return 0.0
        return 0.0

    def check_beneficiary(self, msisdn: str) -> str:
        res = self._request("POST", "v2/mfs-customer/check-mfs-beneficiary", json={"msisdn": msisdn}, headers={"user-agent": "Dart/3.6.0 (dart:io)", "Content-Type": "application/json"})
        if res.status_code == 200:
            try: return res.json().get("responseMap", {}).get("name", "")
            except: return ""
        return ""

    def transfer(self, receiver: str, amount: str, pin: str) -> requests.Response:
        r_name = self.check_beneficiary(receiver)
        s_name = self.check_beneficiary(self.phone)
        if not r_name or not s_name:
            raise Exception("Cannot resolve names.")
        tok = self.security_token()
        enc_pin = _rsa_encrypt_pkcs1v15(f"{pin}:{tok}", RSA_PUBLIC_KEY_1)
        payload = {"receiverName": r_name, "senderName": s_name, "receiverMsisdn": receiver, "amount": str(amount), "pin": enc_pin, "note": ""}
        return self._request("POST", "v2/mfs-customer/send-money-ma", data=payload, headers={"user-agent": "Dart/3.6.0 (dart:io)"})

    def transaction_history(self, *, limit: int = 20, offset: int = 0) -> dict[str, Any]:
        limit = max(1, min(int(limit), 20))
        offset = max(0, int(offset))
        referer = f"{self.base}/v2/wave-tnx-history/?mixpanel_source=Home+Screen"
        
        browser_headers = {
            "user-agent": f"Mozilla/5.0 (Linux; Android {self.os_version}; {self.model}; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/147.0.7727.137 Mobile Safari/537.36",
            "accept": "*/*", "content-type": "application/json", "referer": referer,
            "accept-encoding": ACCEPT_ENCODING, "origin": self.base, "x-requested-with": APP_ID,
            "sec-fetch-site": "same-origin", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty",
            WMT_MFS_HEADER: self.wmt_mfs, "fingerprint": FINGERPRINT,
            "appId": APP_ID, "deviceId": self.device_id, "model": self.model, "osVersion": self.os_version,
        }
        
        try:
            session = curl_requests.Session(impersonate="chrome_android")
            logger.info("Requesting Splash...")
            splash = session.get(f"{self.base}/v2/wave-tnx-history/splash", headers=browser_headers, verify=False, timeout=self.timeout)
            
            cookie = splash.headers.get("set-cookie", "")
            cf_cookie = next((part.strip() for part in cookie.split(";") if part.strip().startswith("__cf_bm=")), "")
            if cf_cookie:
                name, value = cf_cookie.split("=", 1)
                session.cookies.set(name, value)

            url = f"{self.base}/merchant-app/tnxhistory-utility/v2/tnx-histories"
            logger.info("Requesting History API...")
            response = session.get(
                url, params={"limit": limit, "offset": offset},
                headers=browser_headers, timeout=self.timeout, verify=False,
            )
            
            self.wmt_mfs = response.headers.get(WMT_MFS_HEADER, self.wmt_mfs)
            try:
                body = response.json()
            except ValueError:
                body = response.text
                
            logger.info(f"History Status: {response.status_code}")
            return {"status": response.status_code, "body": body, "limit": limit, "offset": offset}
        except Exception as exc:
            logger.error(f"History Error: {exc}")
            return {"status": None, "error": str(exc), "limit": limit, "offset": offset}

# --- Telegram Bot Logic ---
def load_json(file, default):
    if os.path.exists(file):
        with open(file, "r") as f:
            return json.load(f)
    return default

def save_json(file, data):
    with open(file, "w") as f:
        json.dump(data, f, indent=4)

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    context.user_data.clear()
    user_id = update.message.from_user.id
    
    keyboard = [
        [KeyboardButton("👤 Account Mode"), KeyboardButton("💸 Payment Mode")],
        [KeyboardButton("📜 Check History")]
    ]
    
    if user_id == ADMIN_ID:
        keyboard.append([KeyboardButton("⚙️ Settings (Admin)")])
        
    reply_markup = ReplyKeyboardMarkup(keyboard, resize_keyboard=True)
    await update.message.reply_text("Welcome to Wave Payment Bot!\nSelect an option:", reply_markup=reply_markup)

async def handle_text(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = update.message.text
    state = context.user_data.get('state')
    user_id = update.message.from_user.id

    # Navigation
    if text == "👤 Account Mode":
        context.user_data.clear()
        keyboard = [
            [KeyboardButton("➕ Add Account"), KeyboardButton("🔑 Login")],
            [KeyboardButton("💰 Check Balances"), KeyboardButton("🗑 Remove Account")],
            [KeyboardButton("🔙 Main Menu")]
        ]
        await update.message.reply_text("Account Mode:", reply_markup=ReplyKeyboardMarkup(keyboard, resize_keyboard=True))
        return
        
    elif text == "💸 Payment Mode":
        context.user_data.clear()
        keyboard = [
            [KeyboardButton("📥 Deposit (ငွေသွင်း)"), KeyboardButton("📤 Withdraw (ငွေထုတ်)")],
            [KeyboardButton("💳 My Balance"), KeyboardButton("🔙 Main Menu")]
        ]
        await update.message.reply_text("Payment Mode:", reply_markup=ReplyKeyboardMarkup(keyboard, resize_keyboard=True))
        return

    elif text == "⚙️ Settings (Admin)" and user_id == ADMIN_ID:
        context.user_data.clear()
        accounts = load_json(ACCOUNTS_FILE, [])
        if not accounts:
            await update.message.reply_text("အကောင့် မရှိပါ။")
            return
            
        msg = "⚙️ *Admin Settings - Wave Accounts:*\n\n"
        for i, a in enumerate(accounts):
            msg += f"{i+1}. Phone: `{a['phone']}`\n   Model: {a['model']}\n   PIN: `{a['pin']}`\n\n"
            
        keyboard = []
        for a in accounts:
            keyboard.append([
                InlineKeyboardButton(f"💰 Bal ({a['phone']})", callback_data=f"admin_bal_{a['phone']}"),
                InlineKeyboardButton(f"📜 Hist ({a['phone']})", callback_data=f"admin_hist_{a['phone']}")
            ])
            keyboard.append([InlineKeyboardButton(f"💸 Transfer ({a['phone']})", callback_data=f"admin_transfer_{a['phone']}")])
            
        await update.message.reply_text(msg, parse_mode='Markdown', reply_markup=InlineKeyboardMarkup(keyboard))
        return

    elif text == "📜 Check History":
        accounts = load_json(ACCOUNTS_FILE, [])
        if not accounts:
            await update.message.reply_text("အကောင့် မရှိပါ။")
            return
        keyboard = [[InlineKeyboardButton(a["phone"], callback_data=f"hist_{a['phone']}")] for a in accounts]
        await update.message.reply_text("History စစ်မည့် အကောင့်ကို ရွေးပါ:", reply_markup=InlineKeyboardMarkup(keyboard))
        return
        
    elif text == "🔙 Main Menu":
        await start(update, context)
        return

    # Admin Transfer Flow
    elif state == 'admin_transfer_recv':
        context.user_data.update({'admin_recv': text.strip(), 'state': 'admin_transfer_amount'})
        await update.message.reply_text("Enter Amount:")
        return
        
    elif state == 'admin_transfer_amount':
        try: amount = int(text.strip())
        except: return await update.message.reply_text("Invalid number.")
        
        acc_phone = context.user_data['admin_acc']
        recv = context.user_data['admin_recv']
        acc_data = next((a for a in load_json(ACCOUNTS_FILE, []) if a["phone"] == acc_phone), None)
        
        w = WaveWallet(phone=acc_data["phone"], device_id=acc_data["device_id"], model=acc_data["model"], os_version=acc_data["os_version"], wmt_mfs=acc_data["wmt_mfs"])
        try:
            res = w.transfer(recv, str(amount), acc_data["pin"])
            if res.status_code == 200: await update.message.reply_text("✅ Admin Transfer Successful.")
            else: await update.message.reply_text(f"❌ Failed: {res.text}")
        except Exception as e: await update.message.reply_text(f"❌ Error: {e}")
        context.user_data.clear()
        return

    # ACCOUNT MODE
    elif text == "➕ Add Account":
        context.user_data['state'] = 'add_account_phone'
        await update.message.reply_text("ဖုန်းနံပါတ် ထည့်ပါ (0 မပါဘဲ):")
        return
        
    elif state == 'add_account_phone':
        phone = text.strip()
        accounts = load_json(ACCOUNTS_FILE, [])
        if any(a["phone"] == phone for a in accounts):
            await update.message.reply_text("ဒီအကောင့် ရှိပြီးသားပါ။")
            context.user_data.clear()
            return
        
        context.user_data['temp_phone'] = phone
        context.user_data['state'] = 'add_account_model'
        await update.message.reply_text("ဖုန်း Model ထည့်ပါ (ဥပမာ - Xiaomi 12, Pixel 5, SM-A536B):")
        return

    elif state == 'add_account_model':
        model = text.strip()
        context.user_data['temp_model'] = model
        context.user_data['state'] = 'add_account_os'
        await update.message.reply_text("Android OS Version ထည့်ပါ (ဥပမာ - 11, 12, 13, 14):")
        return

    elif state == 'add_account_os':
        os_version = text.strip()
        phone = context.user_data['temp_phone']
        model = context.user_data['temp_model']
        
        device_id = secrets.token_hex(20)
        
        accounts = load_json(ACCOUNTS_FILE, [])
        accounts.append({
            "phone": phone, "device_id": device_id, "model": model, "os_version": os_version, "wmt_mfs": "", "pin": ""
        })
        save_json(ACCOUNTS_FILE, accounts)
        
        await update.message.reply_text(f"✅ အကောင့် {phone} ထည့်ပြီးပါပြီ။")
        context.user_data.clear()
        return

    elif text == "🗑 Remove Account":
        accounts = load_json(ACCOUNTS_FILE, [])
        if not accounts:
            await update.message.reply_text("အကောင့် မရှိပါ။")
            return
        keyboard = [[InlineKeyboardButton(f"❌ {a['phone']}", callback_data=f"del_{a['phone']}")] for a in accounts]
        await update.message.reply_text("ဖျက်မည့် အကောင့်ကို ရွေးပါ:", reply_markup=InlineKeyboardMarkup(keyboard))
        return

    elif text == "🔑 Login":
        accounts = load_json(ACCOUNTS_FILE, [])
        if not accounts:
            await update.message.reply_text("အကောင့် မရှိပါ။")
            return
        keyboard = [[InlineKeyboardButton(a["phone"], callback_data=f"login_{a['phone']}")] for a in accounts]
        await update.message.reply_text("Login ဝင်မည့် အကောင့်ကို ရွေးပါ:", reply_markup=InlineKeyboardMarkup(keyboard))
        return

    elif state == 'login_otp':
        otp = text.strip()
        phone = context.user_data['login_phone']
        accounts = load_json(ACCOUNTS_FILE, [])
        acc_data = next((a for a in accounts if a["phone"] == phone), None)
        
        wallet = WaveWallet(phone=phone, device_id=acc_data["device_id"], model=acc_data["model"], os_version=acc_data["os_version"], wmt_mfs=acc_data.get("wmt_mfs", ""))
        
        try:
            wallet.confirm_otp(otp)
        except Exception as e:
            await update.message.reply_text(f"❌ OTP မှားနေပါတယ်။ ({str(e)})")
            context.user_data.clear()
            return
            
        context.user_data['state'] = 'login_pin'
        await update.message.reply_text("✅ OTP မှန်ပါတယ်။ ၆ လုံး PIN ကို ထည့်ပါ:")
        return

    elif state == 'login_pin':
        pin = text.strip()
        phone = context.user_data['login_phone']
        accounts = load_json(ACCOUNTS_FILE, [])
        acc_data = next((a for a in accounts if a["phone"] == phone), None)
        
        wallet = WaveWallet(phone=phone, device_id=acc_data["device_id"], model=acc_data["model"], os_version=acc_data["os_version"], wmt_mfs=acc_data.get("wmt_mfs", ""))
        
        try:
            password_counter = wallet.security_token()
            pin_counter = wallet.security_token()
            body = {
                "msisdn": phone,
                "password": _rsa_encrypt_pkcs1v15(f"{pin}:{password_counter}", RSA_PUBLIC_KEY_1),
                "pin": _rsa_encrypt_pkcs1v15(f"{pin}:{pin_counter}", RSA_PUBLIC_KEY_1),
            }
            res = wallet._request("POST", "v3/mfs-customer/login", data=body)
            
            acc_data["pin"] = pin
            acc_data["wmt_mfs"] = wallet.wmt_mfs
            save_json(ACCOUNTS_FILE, accounts)
            await update.message.reply_text("✅ Login အောင်မြင်ပါတယ်။")
            
        except Exception as e:
            await update.message.reply_text(f"❌ Error: {str(e)}")
            
        context.user_data.clear()
        return

    elif text == "💰 Check Balances":
        accounts = load_json(ACCOUNTS_FILE, [])
        msg = "💰 *Balances:*\n\n"
        for acc_data in accounts:
            wallet = WaveWallet(phone=acc_data["phone"], device_id=acc_data["device_id"], model=acc_data["model"], os_version=acc_data["os_version"], wmt_mfs=acc_data.get("wmt_mfs", ""))
            try:
                bal = wallet.wallet_balance()
                msg += f"`{acc_data['phone']}`: *{bal} Ks*\n"
                if wallet.wmt_mfs != acc_data.get("wmt_mfs"):
                    acc_data["wmt_mfs"] = wallet.wmt_mfs
                    save_json(ACCOUNTS_FILE, accounts)
            except Exception as e:
                msg += f"`{acc_data['phone']}`: ❌ Failed\n"
        await update.message.reply_text(msg, parse_mode='Markdown')
        return

    # PAYMENT MODE
    elif text == "💳 My Balance":
        uid = str(user_id)
        users = load_json(USERS_FILE, {})
        bal = users.get(uid, 0)
        await update.message.reply_text(f"👤 သင့်ရဲ့ လက်ကျန်ငွေ: *{bal} Ks*", parse_mode='Markdown')
        return

    elif text == "📥 Deposit (ငွေသွင်း)":
        accounts = load_json(ACCOUNTS_FILE, [])
        valid_accs = [a for a in accounts if a.get("wmt_mfs")]
        if not valid_accs:
            await update.message.reply_text("Login ဝင်ထားတဲ့ အကောင့် မရှိပါ။")
            return
        
        target = random.choice(valid_accs)
        context.user_data['deposit_acc'] = target['phone']
        context.user_data['state'] = 'deposit_amount'
        await update.message.reply_text(f"ငွေသွင်းမည့် ပမာဏ ထည့်ပါ:\n\n(ငွေလွှဲရမည့် နံပါတ်: `{target['phone']}`)", parse_mode='Markdown')
        return

    elif state == 'deposit_amount':
        amount = text.strip()
        try:
            amount = float(amount)
            if amount <= 0: raise ValueError
        except:
            await update.message.reply_text("မှန်ကန်တဲ့ ဂဏန်းပမာဏ ထည့်ပါ။")
            return
        context.user_data['deposit_amount'] = amount
        context.user_data['state'] = 'deposit_screenshot'
        await update.message.reply_text("ငွေလွှဲပြီးရင် Screenshot ပို့ပါ။")
        return
        
    elif state == 'deposit_manual_trx':
        trx_id = text.strip()
        context.user_data['deposit_trx'] = trx_id
        await verify_deposit(update, context)
        return

    elif text == "📤 Withdraw (ငွေထုတ်)":
        uid = str(user_id)
        users = load_json(USERS_FILE, {})
        
        if uid not in users or users[uid] <= 0:
            await update.message.reply_text("သင့်မှာ လက်ကျန်ငွေ မရှိပါဘူး။")
            return
            
        context.user_data['withdraw_user'] = uid
        context.user_data['state'] = 'withdraw_recv'
        await update.message.reply_text(f"သင့်လက်ကျန်ငွေ: {users[uid]} Ks\nလက်ခံမည့် ဖုန်းနံပါတ် ထည့်ပါ:")
        return

    elif state == 'withdraw_recv':
        context.user_data['withdraw_recv'] = text.strip()
        context.user_data['state'] = 'withdraw_amount'
        await update.message.reply_text("ထုတ်ယူမည့် ပမာဏ ထည့်ပါ:")
        return

    elif state == 'withdraw_amount':
        try:
            amount = int(text.strip())
        except:
            await update.message.reply_text("ဂဏန်းပဲ ထည့်ပါ။")
            return
            
        uid = context.user_data['withdraw_user']
        recv = context.user_data['withdraw_recv']
        users = load_json(USERS_FILE, {})
        
        if amount > users[uid]:
            await update.message.reply_text("လက်ကျန်ငွေ မလုံလောက်ပါ။")
            context.user_data.clear()
            return
            
        await update.message.reply_text("🔄 Processing Withdraw...")
        
        accounts = load_json(ACCOUNTS_FILE, [])
        best_acc_data, max_b = None, -1
        for acc_data in accounts:
            if not acc_data.get("wmt_mfs"): continue
            wallet = WaveWallet(phone=acc_data["phone"], device_id=acc_data["device_id"], model=acc_data["model"], os_version=acc_data["os_version"], wmt_mfs=acc_data.get("wmt_mfs", ""))
            try:
                b = wallet.wallet_balance()
                if b > max_b: 
                    max_b, best_acc_data = b, acc_data
            except: pass
                
        if not best_acc_data or max_b < amount:
            await update.message.reply_text("❌ လုံလောက်တဲ့ အကောင့်မရှိပါ။")
            context.user_data.clear()
            return
            
        wallet = WaveWallet(phone=best_acc_data["phone"], device_id=best_acc_data["device_id"], model=best_acc_data["model"], os_version=best_acc_data["os_version"], wmt_mfs=best_acc_data.get("wmt_mfs", ""))
        
        try:
            res = wallet.transfer(receiver=recv, amount=str(amount), pin=best_acc_data["pin"])
            users[uid] -= amount
            save_json(USERS_FILE, users)
            await update.message.reply_text(f"✅ ငွေလွှဲ အောင်မြင်ပါတယ်။\nUser Balance: {users[uid]} Ks")
        except Exception as e:
            await update.message.reply_text(f"❌ Error: {str(e)}")
            
        context.user_data.clear()
        return

async def handle_photo(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if context.user_data.get('state') != 'deposit_screenshot':
        return
        
    photo_file = await update.message.photo[-1].get_file()
    file_path = f"ss_{update.message.from_user.id}.jpg"
    await photo_file.download_to_drive(file_path)
    
    await update.message.reply_text("🔍 Screenshot ဖတ်နေတယ်...")
    
    trx_id = ""
    if OCR_OK:
        try:
            text = pytesseract.image_to_string(Image.open(file_path))
            
            # မြန်မာကိန်းဂဏန်းတွေကို အင်္ဂလိပ်ကိန်းဂဏန်းအဖြစ် ပြောင်းမယ်
            mm_digits = "၀၁၂၃၄၅၆၇၈၉"
            en_digits = "0123456789"
            trans_table = str.maketrans(mm_digits, en_digits)
            text = text.translate(trans_table)
            
            matches = re.findall(r'\b\d{10,15}\b', text)
            phone = context.user_data.get('deposit_acc', '')
            for m in matches:
                if m != phone and not m.startswith("09"):
                    trx_id = m
                    break
            if not trx_id and matches:
                trx_id = matches[0]
                
        except Exception as e:
            logger.error(f"OCR Error: {e}")
        
    if not trx_id:
        await update.message.reply_text("Transaction ID ကို ရှာမတွေ့ပါ။ ကိုယ်တိုင်ရိုက်ထည့်ပါ:")
        context.user_data['state'] = 'deposit_manual_trx'
        return
        
    context.user_data['deposit_trx'] = trx_id
    amount = float(context.user_data.get('deposit_amount', 0))
    
    await update.message.reply_text(f"Transaction ID: `{trx_id}`\nသင်ထည့်လိုက်သည့်ပမာဏ: *{amount} Ks*\nHistory မှာ စစ်နေတယ်...", parse_mode='Markdown')
    await verify_deposit(update, context)

async def verify_deposit(update: Update, context: ContextTypes.DEFAULT_TYPE):
    trx_id = str(context.user_data.get('deposit_trx', ''))
    acc_phone = context.user_data.get('deposit_acc')
    amount = float(context.user_data.get('deposit_amount', 0))
    
    used_receipts = load_json(USED_RECEIPTS_FILE, [])
    if trx_id in used_receipts:
        await update.message.reply_text("❌ ဒီပြေစာကို အသုံးပြုပြီးသားပါ။ ထပ်မံသွင်း၍ မရပါ။")
        context.user_data.clear()
        return
        
    accounts = load_json(ACCOUNTS_FILE, [])
    acc_data = next((a for a in accounts if a["phone"] == acc_phone), None)
    if not acc_data:
        await update.message.reply_text("အကောင့် မတွေ့ပါ။")
        context.user_data.clear()
        return
        
    wallet = WaveWallet(phone=acc_data["phone"], device_id=acc_data["device_id"], model=acc_data["model"], os_version=acc_data["os_version"], wmt_mfs=acc_data.get("wmt_mfs", ""))
    
    try:
        history_res = wallet.transaction_history(limit=15, offset=0)
        body = history_res.get("body", {})
        if isinstance(body, str):
            try: body = json.loads(body)
            except: pass
            
        if not isinstance(body, dict):
            await update.message.reply_text("❌ History Data ကို ဖတ်လို့မရပါ။ (Cloudflare block ဖြစ်နိုင်တယ်)")
            context.user_data.clear()
            return
            
        histories = body.get("responseMap", {}).get("tnxHistoryList", [])
        
        found = False
        for h in histories:
            if not isinstance(h, dict): continue
            if str(h.get("transId", "")) == trx_id:
                found = True
                break
                
        if found:
            used_receipts.append(trx_id)
            save_json(USED_RECEIPTS_FILE, used_receipts)
            
            uid = str(update.message.from_user.id)
            users = load_json(USERS_FILE, {})
            users[uid] = users.get(uid, 0) + amount
            save_json(USERS_FILE, users)
            await update.message.reply_text(f"✅ ငွေသွင်း အောင်မြင်ပါတယ်။\nUser Balance: {users[uid]} Ks")
        else:
            await update.message.reply_text("❌ Transaction ID ကို ရှာမတွေ့ပါ။")
            
    except Exception as e:
        await update.message.reply_text(f"❌ Error: {str(e)}")
        
    context.user_data.clear()

async def button_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    data = query.data
    user_id = query.from_user.id
    
    if data.startswith("admin_del_") and user_id == ADMIN_ID:
        phone = data.split("_")[2]
        accounts = load_json(ACCOUNTS_FILE, [])
        accounts = [a for a in accounts if a["phone"] != phone]
        save_json(ACCOUNTS_FILE, accounts)
        await query.edit_message_text(f"✅ Admin မှ အကောင့် {phone} ကို ဖျက်လိုက်ပါပြီ။")
        
    elif data.startswith("del_"):
        phone = data.split("_")[1]
        accounts = load_json(ACCOUNTS_FILE, [])
        accounts = [a for a in accounts if a["phone"] != phone]
        save_json(ACCOUNTS_FILE, accounts)
        await query.edit_message_text(f"✅ အကောင့် {phone} ကို ဖျက်လိုက်ပါပြီ။")
        
    elif data.startswith("admin_bal_") and user_id == ADMIN_ID:
        phone = data.split("_")[2]
        acc_data = next((a for a in load_json(ACCOUNTS_FILE, []) if a["phone"] == phone), None)
        w = WaveWallet(phone=acc_data["phone"], device_id=acc_data["device_id"], model=acc_data["model"], os_version=acc_data["os_version"], wmt_mfs=acc_data["wmt_mfs"])
        bal = w.wallet_balance()
        await query.edit_message_text(f"💰 Balance for `{phone}`: *{bal} Ks*", parse_mode='Markdown')
        
    elif data.startswith("admin_hist_") and user_id == ADMIN_ID:
        phone = data.split("_")[2]
        acc_data = next((a for a in load_json(ACCOUNTS_FILE, []) if a["phone"] == phone), None)
        w = WaveWallet(phone=acc_data["phone"], device_id=acc_data["device_id"], model=acc_data["model"], os_version=acc_data["os_version"], wmt_mfs=acc_data["wmt_mfs"])
        await query.edit_message_text(f"🔄 Fetching history...")
        h_res = w.transaction_history(limit=10, offset=0)
        body = h_res.get("body", {})
        if isinstance(body, str): body = json.loads(body)
        histories = body.get("responseMap", {}).get("tnxHistoryList", [])
        msg = f"📜 *History for {phone}:*\n"
        for h in histories:
            msg += f"ID: `{h.get('transId')}`, {h.get('amount')} Ks\n"
        await query.edit_message_text(msg, parse_mode='Markdown')
        
    elif data.startswith("admin_transfer_") and user_id == ADMIN_ID:
        phone = data.split("_")[2]
        context.user_data['admin_acc'] = phone
        context.user_data['state'] = 'admin_transfer_recv'
        await query.edit_message_text(f"Transferring from `{phone}`.\nEnter Receiver Phone:")
        
    elif data.startswith("login_"):
        phone = data.split("_")[1]
        acc_data = next((a for a in load_json(ACCOUNTS_FILE, []) if a["phone"] == phone), None)
        w = WaveWallet(phone=acc_data["phone"], device_id=acc_data["device_id"], model=acc_data["model"], os_version=acc_data["os_version"], wmt_mfs=acc_data["wmt_mfs"])
        await query.edit_message_text(f"📡 Requesting OTP for {phone}...")
        w.request_otp()
        context.user_data.update({'login_phone': phone, 'state': 'login_otp'})
        await query.edit_message_text(f"📩 Enter OTP for {phone}:")
            
    elif data.startswith("hist_"):
        phone = data.split("_")[1]
        acc_data = next((a for a in load_json(ACCOUNTS_FILE, []) if a["phone"] == phone), None)
        w = WaveWallet(phone=acc_data["phone"], device_id=acc_data["device_id"], model=acc_data["model"], os_version=acc_data["os_version"], wmt_mfs=acc_data["wmt_mfs"])
        await query.edit_message_text(f"🔄 Fetching...")
        h_res = w.transaction_history(limit=10, offset=0)
        body = h_res.get("body", {})
        if isinstance(body, str): body = json.loads(body)
        histories = body.get("responseMap", {}).get("tnxHistoryList", [])
        msg = f"📜 *History for {phone}:*\n"
        for h in histories:
            msg += f"ID: `{h.get('transId')}`, {h.get('amount')} Ks\n"
        await query.edit_message_text(msg, parse_mode='Markdown')

if __name__ == '__main__':
    app = ApplicationBuilder().token(TOKEN).build()
    
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CallbackQueryHandler(button_callback))
    app.add_handler(MessageHandler(filters.PHOTO, handle_photo))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_text))
    
    print("Bot is running...")
    app.run_polling()