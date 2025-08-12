# app.py
from flask import Flask, jsonify, render_template, request, redirect, url_for
from flask_login import LoginManager, UserMixin, login_user, logout_user, login_required, current_user
from flask_bcrypt import Bcrypt
import yfinance as yf
import pandas as pd
import os
import math
from datetime import datetime, timedelta
import firebase_admin
from firebase_admin import credentials, firestore, auth

# --- INITIALIZATION ---
# Initialize Firebase Admin SDK
# The GOOGLE_APPLICATION_CREDENTIALS environment variable should be set with the path to your service account key file.
# On Render, you can set this as a secret file.
try:
    cred = credentials.ApplicationDefault()
    firebase_admin.initialize_app(cred)
except Exception as e:
    print(f"Warning: Firebase Admin SDK not initialized. Missing credentials? Error: {e}")
    # Fallback for local development if you store key in a specific path
    if os.path.exists('serviceAccountKey.json'):
        cred = credentials.Certificate('serviceAccountKey.json')
        firebase_admin.initialize_app(cred)
    else:
        print("CRITICAL: serviceAccountKey.json not found and GOOGLE_APPLICATION_CREDENTIALS not set.")


db = firestore.client()
bcrypt = Bcrypt()
login_manager = LoginManager()
login_manager.login_view = 'login'
login_manager.login_message_category = 'info'

# Initialize the Flask application
app = Flask(__name__,
            static_folder='static',
            template_folder='templates')

# --- CONFIGURATION ---
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'a-fallback-secret-key-for-development')

# Now, associate the extensions with the app instance.
bcrypt.init_app(app)
login_manager.init_app(app)


# --- USER MODEL & AUTH ---
class User(UserMixin):
    """User class for Flask-Login."""
    def __init__(self, user_id, username, role='guest', password_hash=None):
        self.id = user_id
        self.username = username
        self.role = role
        self.password_hash = password_hash

    def to_dict(self):
        return {'id': self.id, 'username': self.username, 'role': self.role}

    def set_password(self, password):
        self.password_hash = bcrypt.generate_password_hash(password).decode('utf-8')

    def check_password(self, password):
        if not self.password_hash:
            return False
        return bcrypt.check_password_hash(self.password_hash, password)

    @staticmethod
    def get(user_id):
        user_doc = db.collection('users').document(user_id).get()
        if user_doc.exists:
            user_data = user_doc.to_dict()
            return User(user_id=user_doc.id, **user_data)
        return None

@login_manager.user_loader
def load_user(user_id):
    """Flask-Login hook to load a user."""
    return User.get(user_id)

# --- HELPER FUNCTIONS ---
def clean_nan(obj):
    """Recursively replace NaN with None in a dictionary or list for JSON compatibility."""
    if isinstance(obj, dict):
        return {k: clean_nan(v) for k, v in obj.items()}
    elif isinstance(obj, list):
        return [clean_nan(i) for i in obj]
    elif isinstance(obj, float) and math.isnan(obj):
        return None
    return obj

def format_df_to_records(df):
    """Safely formats a DataFrame to a list of records for JSON."""
    if df is None or df.empty:
        return []
    df = df.where(pd.notnull(df), None)
    return df.to_dict('records')

def doc_to_dict_with_id(doc):
    """Converts a Firestore document to a dictionary and adds the document ID."""
    if not doc.exists:
        return None
    data = doc.to_dict()
    data['id'] = doc.id
    # Convert Firestore timestamps to ISO format strings for JSON compatibility
    for key, value in data.items():
        if isinstance(value, datetime):
            data[key] = value.isoformat() + 'Z'
    return data

def get_yfinance_quotes(tickers_list):
    """Helper to fetch quotes from a list of tickers."""
    if not tickers_list:
        return {}
    tickers_str = " ".join(tickers_list)
    try:
        tickers = yf.Tickers(tickers_str)
        quotes = {}
        for ts, t in tickers.tickers.items():
            info = t.info
            # Check if info was successfully fetched
            if info and info.get('regularMarketPrice') is not None:
                quotes[ts] = {
                    'currentPrice': info.get('regularMarketPrice'),
                    'previousClose': info.get('previousClose'),
                    'sector': info.get('sector', 'N/A')
                }
            else:
                # Handle cases where ticker is invalid or data is missing
                quotes[ts] = None 
        return quotes
    except Exception as e:
        print(f"Error fetching yfinance quotes: {e}")
        return {}

def aggregate_portfolio(all_transactions):
    """Aggregates real transactions into current positions."""
    portfolio = {}
    # Ensure transactions are sorted by date to process buys before sells
    sorted_transactions = sorted(all_transactions, key=lambda tx: tx.get('date', ''))

    for tx in sorted_transactions:
        if not tx.get('isReal'):
            continue

        symbol = tx['symbol']
        if symbol not in portfolio:
            if tx.get('transactionType') == 'sell':
                continue # Skip sell if no prior buy
            portfolio[symbol] = {
                'symbol': symbol,
                'longName': tx.get('longName'),
                'sector': tx.get('sector'),
                'customSection': tx.get('customSection'),
                'quantity': 0,
                'totalCost': 0,
            }
        
        pos = portfolio[symbol]
        quantity = tx.get('quantity', 0)
        dollar_value = tx.get('dollarValue', 0)

        if tx.get('transactionType') == 'buy':
            pos['quantity'] += quantity
            pos['totalCost'] += dollar_value
        else: # Sell
            if pos['quantity'] > 0:
                avg_cost = pos['totalCost'] / pos['quantity']
                cost_of_sold = avg_cost * quantity
                pos['quantity'] -= quantity
                pos['totalCost'] -= cost_of_sold
        
        pos['customSection'] = tx.get('customSection')

    return [p for p in portfolio.values() if p.get('quantity', 0) > 0.00001]


# --- AUTHENTICATION ROUTES ---
@app.route('/login', methods=['GET', 'POST'])
def login():
    if current_user.is_authenticated:
        return redirect(url_for('index'))
    if request.method == 'POST':
        data = request.get_json()
        username = data.get('username')
        password = data.get('password')
        
        users_ref = db.collection('users').where('username', '==', username).limit(1).stream()
        user_doc = next(users_ref, None)

        if user_doc:
            user_data = user_doc.to_dict()
            user = User(user_id=user_doc.id, **user_data)
            if user.check_password(password):
                login_user(user, remember=True)
                return jsonify({'success': True, 'user': user.to_dict()})

        return jsonify({'success': False, 'error': 'Invalid username or password'}), 401
    return render_template('login.html')

@app.route('/register', methods=['GET', 'POST'])
def register():
    if current_user.is_authenticated:
        return redirect(url_for('index'))
    if request.method == 'POST':
        data = request.get_json()
        username = data.get('username')
        password = data.get('password')
        if not username or not password:
            return jsonify({'success': False, 'error': 'Username and password are required.'}), 400
        
        # Check if username already exists
        existing_users = db.collection('users').where('username', '==', username).limit(1).stream()
        if next(existing_users, None):
            return jsonify({'success': False, 'error': 'Username is already taken.'}), 400
        
        new_user = User(user_id=None, username=username, role='guest')
        new_user.set_password(password)
        
        # Add user to Firestore
        user_data = {
            'username': new_user.username,
            'password_hash': new_user.password_hash,
            'role': new_user.role
        }
        update_time, user_ref = db.collection('users').add(user_data)
        
        # Log the new user in
        new_user.id = user_ref.id
        login_user(new_user, remember=True)
        return jsonify({'success': True, 'user': new_user.to_dict()})
        
    return render_template('register.html')

@app.route('/logout')
@login_required
def logout():
    logout_user()
    return redirect(url_for('login'))

@app.route('/account-partial')
@login_required
def account_partial():
    return render_template('account.html')

# --- USER MANAGEMENT API ---
@app.route('/api/users', methods=['GET'])
@login_required
def get_users():
    if current_user.role != 'admin':
        return jsonify({"error": "Forbidden"}), 403
    users_stream = db.collection('users').stream()
    users_list = [doc_to_dict_with_id(doc) for doc in users_stream]
    return jsonify(users_list)

@app.route('/api/users/<string:user_id>/role', methods=['POST'])
@login_required
def update_user_role(user_id):
    if current_user.role != 'admin':
        return jsonify({"error": "Forbidden"}), 403
    
    user_ref = db.collection('users').document(user_id)
    if not user_ref.get().exists:
        return jsonify({"error": "User not found"}), 404
        
    data = request.get_json()
    new_role = data.get('role')
    if new_role not in ['guest', 'member', 'admin']:
        return jsonify({"error": "Invalid role specified"}), 400

    if user_id == current_user.id and new_role != 'admin':
        return jsonify({"error": "Admins cannot demote themselves."}), 400

    user_ref.update({'role': new_role})
    updated_user_doc = user_ref.get()
    return jsonify({"message": "User role updated successfully.", "user": doc_to_dict_with_id(updated_user_doc)})

@app.route('/api/users/<string:user_id>/username', methods=['POST'])
@login_required
def update_user_username(user_id):
    """Allows an admin to update a user's username."""
    # Ensure the current user is an admin
    if current_user.role != 'admin':
        return jsonify({"error": "Forbidden"}), 403

    # Check if the user exists
    user_ref = db.collection('users').document(user_id)
    if not user_ref.get().exists:
        return jsonify({"error": "User not found"}), 404

    data = request.get_json()
    new_username = data.get('username')

    # Validate the new username
    if not new_username or len(new_username) < 1:
        return jsonify({"error": "Username cannot be empty."}), 400

    # Check if the new username is already taken by another user
    users_ref = db.collection('users').where('username', '==', new_username).limit(1).stream()
    existing_user_doc = next(users_ref, None)
    
    if existing_user_doc and existing_user_doc.id != user_id:
        return jsonify({"error": f"Username '{new_username}' is already taken."}), 409 # 409 Conflict

    # Update the username
    user_ref.update({'username': new_username})
    
    updated_user_doc = user_ref.get()
    return jsonify({
        "message": f"Username for user {user_id} updated successfully.",
        "user": doc_to_dict_with_id(updated_user_doc)
    })


@app.route('/api/users/<string:user_id>/set-password', methods=['POST'])
@login_required
def set_user_password(user_id):
    if current_user.role != 'admin':
        return jsonify({"error": "Forbidden"}), 403
    
    user_ref = db.collection('users').document(user_id)
    user_doc = user_ref.get()
    if not user_doc.exists:
        return jsonify({"error": "User not found"}), 404
    
    if user_id == current_user.id:
        return jsonify({"error": "Use the Account page to change your own password."}), 400

    data = request.get_json()
    new_password = data.get('password')
    if not new_password or len(new_password) < 1:
        return jsonify({"error": "Password cannot be empty."}), 400
        
    temp_user = User(user_id=user_id, username=user_doc.to_dict().get('username'))
    temp_user.set_password(new_password)
    user_ref.update({'password_hash': temp_user.password_hash})
    
    return jsonify({"message": f"Password for {temp_user.username} has been updated."})

@app.route('/api/account/update', methods=['POST'])
@login_required
def update_account():
    data = request.get_json()
    new_username = data.get('username')
    current_password = data.get('current_password')
    new_password = data.get('new_password')

    user_ref = db.collection('users').document(current_user.id)
    user_updated = False
    update_data = {}

    if new_username and new_username != current_user.username:
        existing_users = db.collection('users').where('username', '==', new_username).limit(1).stream()
        if next(existing_users, None):
            return jsonify({"success": False, "error": "Username is already taken."}), 409
        update_data['username'] = new_username
        user_updated = True

    if new_password:
        if not current_password or not current_user.check_password(current_password):
            return jsonify({"success": False, "error": "Current password is incorrect."}), 401
        current_user.set_password(new_password)
        update_data['password_hash'] = current_user.password_hash
        user_updated = True
    
    if user_updated:
        user_ref.update(update_data)
        return jsonify({"success": True, "message": "Account updated successfully."})

    return jsonify({"success": False, "error": "No changes requested."}), 400

@app.route('/api/users/<string:user_id>', methods=['DELETE'])
@login_required
def delete_user(user_id):
    if current_user.role != 'admin':
        return jsonify({"error": "Forbidden"}), 403

    user_ref = db.collection('users').document(user_id)
    if not user_ref.get().exists:
        return jsonify({"error": "User not found"}), 404

    if user_id == current_user.id:
        return jsonify({"error": "You cannot delete your own account."}), 400

    try:
        # Manually delete user's votes to avoid needing a special index.
        # This is less performant at scale but works without manual setup.
        presentations_stream = db.collection('presentations').stream()
        for presentation in presentations_stream:
            vote_ref = presentation.reference.collection('votes').document(user_id)
            vote_doc = vote_ref.get()
            if vote_doc.exists:
                vote_ref.delete()

        # After cleaning up votes, delete the user.
        user_ref.delete()
        
        # Return a success message.
        return jsonify({"message": "User and all associated votes have been deleted successfully."})

    except Exception as e:
        print(f"An error occurred during user deletion: {e}")
        return jsonify({"error": "An internal error occurred while trying to delete the user."}), 500


# --- HTML & API ROUTES ---
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/status')
def get_status():
    if current_user.is_authenticated:
        return jsonify({
            'loggedIn': True,
            'user': current_user.to_dict()
        })
    else:
        return jsonify({'loggedIn': False})

@app.route('/api/homepage-data')
def get_homepage_data():
    is_member = current_user.is_authenticated and current_user.role != 'guest'
    
    try:
        if is_member:
            # Members/Admins see portfolio and watchlist
            title = "Portfolio Snapshot"
            transactions_stream = db.collection('holdings').stream() # No sort here
            all_transactions = [doc_to_dict_with_id(doc) for doc in transactions_stream]
            
            real_positions = aggregate_portfolio(all_transactions)
            real_position_symbols = {p['symbol'] for p in real_positions}
            
            watchlist_items = [
                tx for tx in all_transactions 
                if not tx.get('isReal') and tx.get('symbol') not in real_position_symbols
            ]
            
            # Sort watchlist items in Python
            watchlist_items.sort(key=lambda x: x.get('date', ''), reverse=True)
            
            items_to_display = real_positions + watchlist_items
            
        else:
            # Guests see only the watchlist
            title = "Club Watchlist"
            # FIX: Remove order_by to prevent index error. Sorting is done in Python.
            watchlist_stream = db.collection('holdings').where('isReal', '==', False).stream()
            items_to_display_unsorted = [doc_to_dict_with_id(doc) for doc in watchlist_stream]
            # Sort the results in the application code instead of the query
            items_to_display = sorted(items_to_display_unsorted, key=lambda x: x.get('date', ''), reverse=True)

        # Fetch quotes for all items
        tickers = list(set(item['symbol'] for item in items_to_display if item.get('symbol')))
        quotes = get_yfinance_quotes(tickers)

        # Add quote data to each item
        for item in items_to_display:
            symbol = item.get('symbol')
            if symbol and symbol in quotes:
                item['quote'] = quotes[symbol]

        return jsonify({
            "title": title,
            "items": clean_nan(items_to_display)
        })
    except Exception as e:
        print(f"Error in get_homepage_data: {e}")
        return jsonify({"error": "An internal error occurred."}), 500


# ... (Keep all yfinance routes: /api/quotes, /api/stock/<ticker_symbol>/history, /api/stock/<ticker_symbol>)
# These routes do not interact with the database and can remain unchanged.
@app.route('/api/quotes', methods=['POST'])
def get_quotes():
    try:
        data = request.get_json()
        tickers_str = " ".join(data.get('tickers', []))
        if not tickers_str: return jsonify({})
        
        tickers = yf.Tickers(tickers_str)
        quotes = {}
        for ts, t in tickers.tickers.items():
            info = t.info
            quotes[ts] = {
                'currentPrice': info.get('regularMarketPrice'),
                'previousClose': info.get('previousClose'),
                'sector': info.get('sector', 'N/A')
            }
        return jsonify(quotes)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

def format_financial_data(df):
    if df is None or df.empty:
        return None
    df.columns = df.columns.strftime('%Y-%m-%d')
    return df.transpose().to_dict()

@app.route('/api/stock/<ticker_symbol>/history')
def get_stock_history(ticker_symbol):
    period = request.args.get('period', '1y')
    interval = request.args.get('interval', '1d')

    try:
        stock = yf.Ticker(ticker_symbol)
        hist = stock.history(period=period, interval=interval)
        hist.reset_index(inplace=True)

        if 'Datetime' in hist.columns:
            hist['Timestamp'] = hist['Datetime'].dt.strftime('%Y-%m-%d %H:%M:%S')
            hist_data = hist[['Timestamp', 'Close']].to_dict('records')
        elif 'Date' in hist.columns:
            hist['Timestamp'] = hist['Date'].dt.strftime('%Y-%m-%d')
            hist_data = hist[['Timestamp', 'Close']].to_dict('records')
        else:
            return jsonify({"error": "Could not find a date column."}), 404

        cleaned_data = clean_nan(hist_data)
        return jsonify(cleaned_data)
    except Exception as e:
        print(f"Error fetching history for {ticker_symbol}: {e}")
        return jsonify({"error": "Failed to fetch historical data."}), 500

@app.route('/api/stock/<ticker_symbol>')
def get_stock_data(ticker_symbol):
    try:
        stock = yf.Ticker(ticker_symbol)
        info = stock.info
        
        if not info or 'regularMarketPrice' not in info or info.get('regularMarketPrice') is None:
            return jsonify({"error": "Invalid ticker or data not available"}), 404
        
        hist = stock.history(period="max").reset_index()
        hist['Date'] = hist['Date'].dt.strftime('%Y-%m-%d')
        
        major_holders = stock.major_holders
        institutional_holders = stock.institutional_holders
        sustainability = stock.sustainability
        recommendations = stock.recommendations
        calendar = stock.calendar
        news = stock.news

        data = {
            'info': {
                'symbol': info.get('symbol'), 'longName': info.get('longName'),
                'sector': info.get('sector', 'Other'), 'industry': info.get('industry'),
                'longBusinessSummary': info.get('longBusinessSummary'),
                'fullTimeEmployees': info.get('fullTimeEmployees'),
                'city': info.get('city'), 'state': info.get('state'), 'country': info.get('country'),
                'website': info.get('website'),
            },
            'market_data': {
                'currentPrice': info.get('regularMarketPrice'), 'dayHigh': info.get('dayHigh'),
                'dayLow': info.get('dayLow'), 'marketCap': info.get('marketCap'),
                'volume': info.get('volume'), 'fiftyTwoWeekHigh': info.get('fiftyTwoWeekHigh'),
                'fiftyTwoWeekLow': info.get('fiftyTwoWeekLow'), 'fiftyDayAverage': info.get('fiftyDayAverage'),
                'twoHundredDayAverage': info.get('twoHundredDayAverage'),
            },
            'valuation_ratios': {
                'trailingPE': info.get('trailingPE'), 'forwardPE': info.get('forwardPE'),
                'priceToBook': info.get('priceToBook'), 'priceToSales': info.get('priceToSalesTrailing12Months'),
                'pegRatio': info.get('pegRatio'), 'enterpriseToEbitda': info.get('enterpriseToEbitda'),
            },
            'profitability': {
                'profitMargins': info.get('profitMargins'), 'returnOnAssets': info.get('returnOnAssets'),
                'returnOnEquity': info.get('returnOnEquity'),
            },
            'dividends_splits': {
                'dividendRate': info.get('dividendRate'), 'dividendYield': info.get('dividendYield'),
                'exDividendDate': pd.to_datetime(info.get('exDividendDate'), unit='s').strftime('%Y-%m-%d') if info.get('exDividendDate') else None,
                'payoutRatio': info.get('payoutRatio'), 'lastSplitFactor': info.get('lastSplitFactor'),
                'lastSplitDate': pd.to_datetime(info.get('lastSplitDate'), unit='s').strftime('%Y-%m-%d') if info.get('lastSplitDate') else None,
            },
            'analyst_info': {
                'recommendationKey': info.get('recommendationKey'), 'targetMeanPrice': info.get('targetMeanPrice'),
                'targetHighPrice': info.get('targetHighPrice'), 'targetLowPrice': info.get('targetLowPrice'),
                'numberOfAnalystOpinions': info.get('numberOfAnalystOpinions'),
            },
            'financials': {
                'income_statement_annual': format_financial_data(stock.financials),
                'income_statement_quarterly': format_financial_data(stock.quarterly_financials),
                'balance_sheet_annual': format_financial_data(stock.balance_sheet),
                'balance_sheet_quarterly': format_financial_data(stock.quarterly_balance_sheet),
                'cash_flow_annual': format_financial_data(stock.cashflow),
                'cash_flow_quarterly': format_financial_data(stock.quarterly_cashflow),
            },
            'ownership': {
                'major_holders': format_df_to_records(major_holders),
                'institutional_holders': format_df_to_records(institutional_holders)
            },
            'sustainability': sustainability.to_dict() if sustainability is not None and not sustainability.empty else None,
            'recommendations_history': format_df_to_records(recommendations),
            'calendar_events': calendar if calendar else None,
            'news': news if news else [],
            'historical': hist[['Date', 'Close']].to_dict('records')
        }
        
        cleaned_data = clean_nan(data)
        return jsonify(cleaned_data)

    except Exception as e:
        print(f"Error fetching data for {ticker_symbol}: {e}")
        return jsonify({"error": f"An error occurred while fetching data for {ticker_symbol}. See server logs."}), 500

# --- DATABASE API ENDPOINTS ---

@app.route('/api/portfolio', methods=['GET'])
@login_required
def get_transactions():
    try:
        transactions_stream = db.collection('holdings').order_by('date').stream()
        transactions = [doc_to_dict_with_id(doc) for doc in transactions_stream]
        return jsonify(transactions)
    except Exception as e:
        print(f"Error fetching portfolio: {e}")
        return jsonify({"error": "Could not fetch portfolio"}), 500

@app.route('/api/transaction', methods=['POST'])
@login_required
def add_transaction():
    data = request.get_json()
    is_real = data.get('isReal', False)

    if is_real and current_user.role != 'admin':
        return jsonify({"error": "Forbidden: Only admins can add real transactions."}), 403
    
    if data.get('transactionType') == 'sell':
        holdings_stream = db.collection('holdings').where('symbol', '==', data['symbol']).where('isReal', '==', True).stream()
        buys = 0
        sells = 0
        for doc in holdings_stream:
            tx = doc.to_dict()
            if tx.get('transactionType') == 'buy':
                buys += tx.get('quantity', 0)
            else:
                sells += tx.get('quantity', 0)
        current_quantity = buys - sells
        
        sell_quantity = float(data.get('quantity', 0))
        if sell_quantity > current_quantity:
            return jsonify({"error": f"Cannot sell {sell_quantity} shares. You only own {current_quantity:.4f}."}), 400

    try:
        stock_info = yf.Ticker(data['symbol']).info
        sector = stock_info.get('sector', 'Other')
        long_name = stock_info.get('longName', data['longName'])
    except Exception:
        sector = 'Other'
        long_name = data['longName']

    new_transaction_data = {
        'symbol': data['symbol'].upper(),
        'longName': long_name,
        'sector': sector,
        'isReal': data['isReal'],
        'quantity': data.get('quantity'),
        'price': data.get('price'),
        'dollarValue': data.get('dollarValue'),
        'date': data.get('date'),
        'customSection': data.get('customSection', sector or 'Default'),
        'transactionType': data.get('transactionType', 'buy')
    }
    
    update_time, new_ref = db.collection('holdings').add(new_transaction_data)
    new_transaction_data['id'] = new_ref.id
    return jsonify(new_transaction_data), 201

@app.route('/api/transaction/<string:transaction_id>', methods=['DELETE'])
def delete_transaction(transaction_id):
    transaction_ref = db.collection('holdings').document(transaction_id)
    transaction_doc = transaction_ref.get()

    if not transaction_doc.exists:
        return jsonify({"error": "Transaction not found"}), 404

    transaction_data = transaction_doc.to_dict()
    is_real_transaction = transaction_data.get('isReal', False)

    # All deletions require a logged-in user.
    if not current_user.is_authenticated:
        return jsonify({"error": "Forbidden: You must be logged in to delete items."}), 403

    # Real transactions can only be deleted by admins.
    if is_real_transaction and current_user.role != 'admin':
        return jsonify({"error": "Forbidden: Only admins can delete real transactions."}), 403
    
    # Watchlist items can be deleted by any logged-in user (member or admin).
    
    transaction_ref.delete()
    return jsonify({"message": "Transaction deleted successfully"})


@app.route('/api/portfolio/section', methods=['POST'])
@login_required
def update_holding_section():
    if current_user.role != 'admin':
        return jsonify({"error": "Forbidden: Only admins can modify sections."}), 403
    data = request.get_json()
    symbol = data.get('symbol')
    new_section = data.get('section')

    if not symbol or not new_section:
        return jsonify({"error": "Missing symbol or section"}), 400
    
    transactions_to_update_stream = db.collection('holdings').where('symbol', '==', symbol).stream()
    
    batch = db.batch()
    count = 0
    for doc in transactions_to_update_stream:
        batch.update(doc.reference, {'customSection': new_section})
        count += 1
    
    if count == 0:
        return jsonify({"error": "No holdings found for this symbol"}), 404
        
    batch.commit()
    return jsonify({"message": f"Section for {symbol} updated to {new_section}"})

# --- PRESENTATIONS ---
@app.route('/api/presentations', methods=['GET'])
@login_required
def get_presentations():
    try:
        presentations_stream = db.collection('presentations').stream()
        presentations_unsorted = [doc_to_dict_with_id(doc) for doc in presentations_stream if doc is not None]
        
        # Safely sort the list in Python, providing a default for 'created_at' if it's missing.
        presentations_list = sorted(
            presentations_unsorted, 
            key=lambda p: p.get('created_at', '1970-01-01T00:00:00Z'), 
            reverse=True
        )

        processed_presentations = []
        for p_data in presentations_list:
            # Safely get the voting end time.
            voting_ends_at_str = p_data.get('votingEndsAt')
            is_voting_open = False
            if voting_ends_at_str:
                try:
                    # Compare timezone-aware datetimes.
                    voting_ends_dt = datetime.fromisoformat(voting_ends_at_str.replace('Z', '+00:00'))
                    is_voting_open = voting_ends_dt > datetime.now(voting_ends_dt.tzinfo)
                except (ValueError, TypeError):
                    # Handle cases where the date string is malformed.
                    is_voting_open = False
            
            p_data['isVotingOpen'] = is_voting_open
            p_data['hasVoted'] = False
            p_data['voteDirection'] = None

            if current_user.is_authenticated:
                vote_ref = db.collection('presentations').document(p_data['id']).collection('votes').document(current_user.id).get()
                if vote_ref.exists:
                    p_data['hasVoted'] = True
                    p_data['voteDirection'] = vote_ref.to_dict().get('vote_type')
            
            if current_user.role != 'admin' and is_voting_open:
                p_data.pop('votes_for', None)
                p_data.pop('votes_against', None)
            
            processed_presentations.append(p_data)
            
        return jsonify(processed_presentations)
    except Exception as e:
        # Log the actual error for debugging.
        print(f"Error fetching presentations: {e}")
        return jsonify({"error": "Database error fetching presentations."}), 500

@app.route('/api/presentations', methods=['POST'])
@login_required
def add_presentation():
    if current_user.role == 'guest':
        return jsonify({"error": "Guests cannot submit presentations."}), 403
    data = request.get_json()
    if not all(k in data for k in ['title', 'url', 'ticker', 'action']):
        return jsonify({"error": "Missing required fields"}), 400
    
    now = datetime.utcnow()
    voting_ends = now + timedelta(hours=48)
    
    new_presentation_data = {
        'title': data['title'],
        'url': data['url'],
        'ticker': data['ticker'].upper(),
        'action': data['action'],
        'created_at': now,
        'voting_ends_at': voting_ends,
        'votes_for': 0,
        'votes_against': 0
    }
    
    update_time, new_ref = db.collection('presentations').add(new_presentation_data)
    new_presentation_data['id'] = new_ref.id
    new_presentation_data['created_at'] = now.isoformat() + 'Z'
    new_presentation_data['voting_ends_at'] = voting_ends.isoformat() + 'Z'
    
    return jsonify(doc_to_dict_with_id(new_ref.get())), 201

@app.route('/api/presentations/<string:presentation_id>/vote', methods=['POST'])
@login_required
def vote_on_presentation(presentation_id):
    if current_user.role == 'guest':
        return jsonify({"error": "Guests cannot vote."}), 403
        
    data = request.get_json()
    vote_type = data.get('voteType')
    
    presentation_ref = db.collection('presentations').document(presentation_id)
    presentation_doc = presentation_ref.get()

    if not presentation_doc.exists:
        return jsonify({"error": "Presentation not found"}), 404
    
    presentation_data = presentation_doc.to_dict()
    
    # Robust check for voting end time
    voting_ends_at = presentation_data.get('voting_ends_at')
    if not voting_ends_at or datetime.utcnow() > voting_ends_at:
        return jsonify({"error": "Voting for this presentation has closed."}), 403
    
    vote_ref = presentation_ref.collection('votes').document(current_user.id)
    if vote_ref.get().exists:
        return jsonify({"error": "You have already voted on this presentation."}), 409

    if vote_type not in ['for', 'against']:
        return jsonify({"error": "Invalid vote type"}), 400

    # Use a transaction to ensure atomicity
    @firestore.transactional
    def update_in_transaction(transaction, pres_ref, vt_ref):
        pres_snapshot = pres_ref.get(transaction=transaction)
        
        # Add the user's vote
        transaction.set(vt_ref, {
            'user_id': current_user.id,
            'vote_type': vote_type
        })
        
        # Update the aggregate count
        if vote_type == 'for':
            transaction.update(pres_ref, {
                'votes_for': pres_snapshot.get('votes_for') + 1
            })
        elif vote_type == 'against':
            transaction.update(pres_ref, {
                'votes_against': pres_snapshot.get('votes_against') + 1
            })

    transaction = db.transaction()
    update_in_transaction(transaction, presentation_ref, vote_ref)
    
    # Re-fetch the presentation data to return the updated state
    updated_presentation_doc = presentation_ref.get()
    return jsonify(doc_to_dict_with_id(updated_presentation_doc))

# --- PAGE CONTENT MANAGEMENT ---
@app.route('/api/page/<page_name>', methods=['GET'])
def get_page_content(page_name):
    content_doc = db.collection('pages').document(page_name).get()
    if content_doc.exists:
        return jsonify(content_doc.to_dict())
    else:
        default_content = {
            'about': {'content': '<h3 class="text-xl font-semibold mb-4 text-cyan-400">Welcome!</h3><p>This is a dashboard for the Muskingum University Investment Club.</p>'},
            'internships': {'content': '<p>This section will list relevant internship opportunities. Check back later for updates.</p>'}
        }
        return jsonify(default_content.get(page_name, {'content': '<p>Content not found.</p>'}))

@app.route('/api/page/<page_name>', methods=['POST'])
@login_required
def update_page_content(page_name):
    if current_user.role != 'admin':
        return jsonify({"error": "Forbidden: Only admins can edit page content."}), 403
    data = request.get_json()
    new_content = data.get('content')
    
    db.collection('pages').document(page_name).set({'content': new_content})
    return jsonify({'message': f'{page_name} content updated successfully.'})

if __name__ == '__main__':
    app.run(debug=True, port=os.environ.get('PORT', 5001))
