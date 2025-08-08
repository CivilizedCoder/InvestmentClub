# app.py
from flask import Flask, jsonify, render_template, request, redirect, url_for
from flask_sqlalchemy import SQLAlchemy
from flask_login import LoginManager, UserMixin, login_user, logout_user, login_required, current_user
from flask_bcrypt import Bcrypt
import yfinance as yf
import pandas as pd
import os
from sqlalchemy import inspect, text, func, UniqueConstraint
from sqlalchemy.exc import ProgrammingError
import math
from datetime import datetime, timedelta
import click

# Initialize extensions
db = SQLAlchemy()
bcrypt = Bcrypt()
login_manager = LoginManager()
login_manager.login_view = 'login' # Redirect to /login if @login_required fails
login_manager.login_message_category = 'info'

@login_manager.user_loader
def load_user(user_id):
    """Flask-Login hook to load a user from the database."""
    return User.query.get(int(user_id))

# Initialize the Flask application
app = Flask(__name__,
            static_folder='static',
            template_folder='templates')

# --- DATABASE CONFIGURATION ---
# Render provides the database URL via an environment variable.
database_url = os.environ.get('DATABASE_URL')

if database_url:
    # Replace 'postgres://' with 'postgresql://' for SQLAlchemy compatibility
    if database_url.startswith("postgres://"):
        database_url = database_url.replace("postgres://", "postgresql://", 1)
    
    # Ensure sslmode=require is present. This is critical for Render databases.
    if '?' in database_url:
        if 'sslmode' not in database_url:
            database_url += '&sslmode=require'
    else:
        database_url += '?sslmode=require'

app.config['SQLALCHEMY_DATABASE_URI'] = database_url
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'a-fallback-secret-key-for-development') # Needed for sessions
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['SQLALCHEMY_ENGINE_OPTIONS'] = { 'pool_pre_ping': True }

# Now, associate the extensions with the app instance.
db.init_app(app)
bcrypt.init_app(app)
login_manager.init_app(app)

# --- DATABASE MODELS ---
class User(UserMixin, db.Model):
    """User model for authentication and roles."""
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    password_hash = db.Column(db.String(128), nullable=False)
    role = db.Column(db.String(20), nullable=False, default='guest') # Roles: 'guest', 'member', 'admin'
    votes = db.relationship('Vote', backref='user', lazy=True, cascade="all, delete-orphan")

    def set_password(self, password):
        self.password_hash = bcrypt.generate_password_hash(password).decode('utf-8')

    def check_password(self, password):
        # The stored hash must be encoded back to bytes for the bcrypt library to read the salt.
        return bcrypt.check_password_hash(self.password_hash.encode('utf-8'), password)

    def to_dict(self):
        return {'id': self.id, 'username': self.username, 'role': self.role}

class Holding(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    symbol = db.Column(db.String(10), nullable=False)
    long_name = db.Column(db.String(100), nullable=False)
    sector = db.Column(db.String(50), nullable=True)
    is_real = db.Column(db.Boolean, nullable=False)
    purchase_type = db.Column(db.String(20))
    quantity = db.Column(db.Float) # Price per share at purchase/sale
    price = db.Column(db.Float) # Total value of transaction
    dollar_value = db.Column(db.Float)
    date = db.Column(db.String(20))
    custom_section = db.Column(db.String(100), nullable=True, default='Default')
    transaction_type = db.Column(db.String(10), nullable=False, default='buy')

    def to_dict(self):
        return {
            'id': self.id, 'symbol': self.symbol, 'longName': self.long_name,
            'sector': self.sector, 'isReal': self.is_real, 
            'purchaseType': self.purchase_type, 'quantity': self.quantity, 
            'price': self.price, 'dollarValue': self.dollar_value, 'date': self.date,
            'customSection': self.custom_section,
            'transactionType': self.transaction_type
        }

class Presentation(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(200), nullable=False)
    url = db.Column(db.String(500), nullable=False)
    ticker = db.Column(db.String(10), nullable=False)
    action = db.Column(db.String(10), nullable=False) # 'Buy' or 'Sell'
    votes_for = db.Column(db.Integer, default=0)
    votes_against = db.Column(db.Integer, default=0)
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
    voting_ends_at = db.Column(db.DateTime, nullable=False)
    votes = db.relationship('Vote', backref='presentation', lazy=True, cascade="all, delete-orphan")

    def to_dict(self):
        role = current_user.role if current_user.is_authenticated else 'guest'
        is_voting_open = datetime.utcnow() < self.voting_ends_at
        
        presentation_dict = {
            'id': self.id,
            'title': self.title,
            'url': self.url,
            'ticker': self.ticker,
            'action': self.action,
            'votingEndsAt': self.voting_ends_at.isoformat() + 'Z', # ISO format for JS
            'isVotingOpen': is_voting_open,
            'hasVoted': False,
            'voteDirection': None
        }

        if current_user.is_authenticated:
            user_vote = Vote.query.filter_by(user_id=current_user.id, presentation_id=self.id).first()
            if user_vote:
                presentation_dict['hasVoted'] = True
                presentation_dict['voteDirection'] = user_vote.vote_type

        # Admins see votes anytime. Members only see votes after the period is closed.
        if role == 'admin' or not is_voting_open:
            presentation_dict['votesFor'] = self.votes_for
            presentation_dict['votesAgainst'] = self.votes_against
        
        return presentation_dict

class Vote(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    presentation_id = db.Column(db.Integer, db.ForeignKey('presentation.id'), nullable=False)
    vote_type = db.Column(db.String(10), nullable=False) # 'for' or 'against'
    __table_args__ = (UniqueConstraint('user_id', 'presentation_id', name='_user_presentation_uc'),)

class PageContent(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    page_name = db.Column(db.String(50), unique=True, nullable=False)
    content = db.Column(db.Text, nullable=False)

# --- INITIAL SETUP AND MIGRATIONS ---
with app.app_context():
    # Create all database tables if they don't exist
    db.create_all()

# Teardown function to ensure database sessions are closed after each request.
@app.teardown_appcontext
def shutdown_session(exception=None):
    db.session.remove()

# --- HELPER FUNCTIONS ---
def add_columns_if_missing():
    """Checks for and adds missing columns to tables."""
    try:
        inspector = inspect(db.engine)
        
        # Check holding table
        holding_columns = [c['name'] for c in inspector.get_columns('holding')]
        with db.engine.connect().execution_options(isolation_level="AUTOCOMMIT") as connection:
            if 'sector' not in holding_columns:
                print("MIGRATION: 'sector' column not found in holding. Adding it now.")
                connection.execute(text('ALTER TABLE holding ADD COLUMN sector VARCHAR(50)'))
                print("MIGRATION: Successfully added 'sector' column.")

            if 'custom_section' not in holding_columns:
                print("MIGRATION: 'custom_section' column not found in holding. Adding it now.")
                connection.execute(text("ALTER TABLE holding ADD COLUMN custom_section VARCHAR(100) DEFAULT 'Default'"))
                print("MIGRATION: Successfully added 'custom_section' column.")

            if 'transaction_type' not in holding_columns:
                print("MIGRATION: 'transaction_type' column not found in holding. Adding it now.")
                connection.execute(text("ALTER TABLE holding ADD COLUMN transaction_type VARCHAR(10) NOT NULL DEFAULT 'buy'"))
                print("MIGRATION: Successfully added 'transaction_type' column.")

        # Check presentation table
        presentation_columns = [c['name'] for c in inspector.get_columns('presentation')]
        with db.engine.connect().execution_options(isolation_level="AUTOCOMMIT") as connection:
            if 'created_at' not in presentation_columns:
                print("MIGRATION: 'created_at' column not found in presentation. Adding it now.")
                connection.execute(text('ALTER TABLE presentation ADD COLUMN created_at TIMESTAMP'))
                connection.execute(text("UPDATE presentation SET created_at = NOW() WHERE created_at IS NULL"))
                connection.execute(text('ALTER TABLE presentation ALTER COLUMN created_at SET NOT NULL'))
                print("MIGRATION: Successfully added 'created_at' column.")

            if 'voting_ends_at' not in presentation_columns:
                print("MIGRATION: 'voting_ends_at' column not found in presentation. Adding it now.")
                connection.execute(text('ALTER TABLE presentation ADD COLUMN voting_ends_at TIMESTAMP'))
                connection.execute(text("UPDATE presentation SET voting_ends_at = created_at WHERE voting_ends_at IS NULL"))
                connection.execute(text('ALTER TABLE presentation ALTER COLUMN voting_ends_at SET NOT NULL'))
                print("MIGRATION: Successfully added 'voting_ends_at' column.")

        return True
    except Exception as e:
        print(f"CRITICAL: Failed to execute migration: {e}")
    return False

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

# --- AUTHENTICATION ROUTES ---
@app.route('/login', methods=['GET', 'POST'])
def login():
    if current_user.is_authenticated:
        return redirect(url_for('index'))
    if request.method == 'POST':
        data = request.get_json()
        user = User.query.filter_by(username=data['username']).first()
        if user and user.check_password(data['password']):
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
        if User.query.filter_by(username=username).first():
            return jsonify({'success': False, 'error': 'Username is already taken.'}), 400
        
        new_user = User(username=username, role='guest') # New users are guests by default
        new_user.set_password(password)
        db.session.add(new_user)
        db.session.commit()
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
    users = User.query.all()
    return jsonify([user.to_dict() for user in users])

@app.route('/api/users/<int:user_id>/role', methods=['POST'])
@login_required
def update_user_role(user_id):
    if current_user.role != 'admin':
        return jsonify({"error": "Forbidden"}), 403
    
    user_to_update = User.query.get(user_id)
    if not user_to_update:
        return jsonify({"error": "User not found"}), 404
        
    data = request.get_json()
    new_role = data.get('role')
    if new_role not in ['guest', 'member', 'admin']:
        return jsonify({"error": "Invalid role specified"}), 400

    # Prevent admin from demoting themselves
    if user_to_update.id == current_user.id and new_role != 'admin':
        return jsonify({"error": "Admins cannot demote themselves."}), 400

    user_to_update.role = new_role
    db.session.commit()
    return jsonify({"message": "User role updated successfully.", "user": user_to_update.to_dict()})

@app.route('/api/users/<int:user_id>/set-password', methods=['POST'])
@login_required
def set_user_password(user_id):
    if current_user.role != 'admin':
        return jsonify({"error": "Forbidden"}), 403
    
    user_to_update = User.query.get(user_id)
    if not user_to_update:
        return jsonify({"error": "User not found"}), 404
    
    if user_to_update.id == current_user.id:
        return jsonify({"error": "Use the Account page to change your own password."}), 400

    data = request.get_json()
    new_password = data.get('password')
    if not new_password or len(new_password) < 1:
        return jsonify({"error": "Password cannot be empty."}), 400
        
    user_to_update.set_password(new_password)
    db.session.commit()
    return jsonify({"message": f"Password for {user_to_update.username} has been updated."})

@app.route('/api/account/update', methods=['POST'])
@login_required
def update_account():
    data = request.get_json()
    new_username = data.get('username')
    current_password = data.get('current_password')
    new_password = data.get('new_password')

    user_updated = False

    # --- Update Username ---
    if new_username and new_username != current_user.username:
        if User.query.filter_by(username=new_username).first():
            return jsonify({"success": False, "error": "Username is already taken."}), 409
        current_user.username = new_username
        user_updated = True

    # --- Update Password ---
    if new_password:
        if not current_password or not current_user.check_password(current_password):
            return jsonify({"success": False, "error": "Current password is incorrect."}), 401
        current_user.set_password(new_password)
        user_updated = True
    
    if user_updated:
        db.session.commit()
        return jsonify({"success": True, "message": "Account updated successfully."})

    return jsonify({"success": False, "error": "No changes requested."}), 400


@app.route('/api/users/<int:user_id>', methods=['DELETE'])
@login_required
def delete_user(user_id):
    if current_user.role != 'admin':
        return jsonify({"error": "Forbidden"}), 403

    user_to_delete = User.query.get(user_id)
    if not user_to_delete:
        return jsonify({"error": "User not found"}), 404

    # Prevent admin from deleting themselves
    if user_to_delete.id == current_user.id:
        return jsonify({"error": "You cannot delete your own account."}), 400

    db.session.delete(user_to_delete)
    db.session.commit()
    return jsonify({"message": "User deleted successfully"})

# --- HTML & API ROUTES ---
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/status')
def get_status():
    """Provides frontend with current user's login status and info."""
    if current_user.is_authenticated:
        return jsonify({
            'loggedIn': True,
            'user': current_user.to_dict()
        })
    else:
        return jsonify({'loggedIn': False})

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
    """Formats financial dataframes from yfinance, where columns are dates."""
    if df is None or df.empty:
        return None
    # The columns are Timestamps, not the index. Format them.
    df.columns = df.columns.strftime('%Y-%m-%d')
    return df.transpose().to_dict()

@app.route('/api/stock/<ticker_symbol>/history')
def get_stock_history(ticker_symbol):
    """
    Fetches historical data for a specific ticker with a given period and interval.
    Used for dynamic chart updates (e.g., 1d, 1w).
    """
    period = request.args.get('period', '1y')
    interval = request.args.get('interval', '1d')

    try:
        stock = yf.Ticker(ticker_symbol)
        hist = stock.history(period=period, interval=interval)
        
        # yfinance returns 'Datetime' for intraday and 'Date' for daily in the index
        hist.reset_index(inplace=True)

        # Check for the appropriate date/datetime column and format it
        if 'Datetime' in hist.columns:
            hist['Timestamp'] = hist['Datetime'].dt.strftime('%Y-%m-%d %H:%M:%S')
            hist_data = hist[['Timestamp', 'Close']].to_dict('records')
        elif 'Date' in hist.columns:
            hist['Timestamp'] = hist['Date'].dt.strftime('%Y-%m-%d')
            hist_data = hist[['Timestamp', 'Close']].to_dict('records')
        else:
            return jsonify({"error": "Could not find a date column in the historical data."}), 404

        # Clean NaN values before returning
        cleaned_data = clean_nan(hist_data)
        return jsonify(cleaned_data)

    except Exception as e:
        print(f"Error fetching history for {ticker_symbol} with period={period}, interval={interval}: {e}")
        return jsonify({"error": "Failed to fetch historical data."}), 500

@app.route('/api/stock/<ticker_symbol>')
def get_stock_data(ticker_symbol):
    """
    Fetches a comprehensive set of data for a stock's main page.
    This includes company info, market data, and max-period daily historical data for the main chart.
    """
    try:
        stock = yf.Ticker(ticker_symbol)
        info = stock.info
        
        if not info or 'regularMarketPrice' not in info or info.get('regularMarketPrice') is None:
            return jsonify({"error": "Invalid ticker or data not available"}), 404
        
        # Fetch max historical data for the initial chart view
        hist = stock.history(period="max").reset_index()
        hist['Date'] = hist['Date'].dt.strftime('%Y-%m-%d')
        
        # Fetch additional data points
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
        
        # Clean data to remove NaN values before returning JSON
        cleaned_data = clean_nan(data)
        return jsonify(cleaned_data)

    except Exception as e:
        print(f"Error fetching data for {ticker_symbol}: {e}")
        return jsonify({"error": f"An error occurred while fetching data for {ticker_symbol}. See server logs."}), 500

# --- DATABASE API ENDPOINTS ---

@app.route('/api/watchlist', methods=['GET'])
def get_watchlist():
    """A public endpoint to get only watchlist items."""
    try:
        watchlist_items = Holding.query.filter_by(is_real=False).order_by(Holding.date.asc()).all()
        return jsonify([t.to_dict() for t in watchlist_items])
    except Exception as e:
        print(f"Error fetching watchlist: {e}")
        return jsonify({"error": "Could not fetch watchlist"}), 500

@app.route('/api/portfolio', methods=['GET'])
@login_required
def get_transactions():
    try:
        transactions = Holding.query.order_by(Holding.date.asc()).all()
        return jsonify([t.to_dict() for t in transactions])
    except ProgrammingError:
        add_columns_if_missing()
        # After migration, try again
        transactions = Holding.query.order_by(Holding.date.asc()).all()
        return jsonify([t.to_dict() for t in transactions])


@app.route('/api/transaction', methods=['POST'])
@login_required
def add_transaction():
    data = request.get_json()
    is_real = data.get('isReal', False)

    # --- Secure Role-Based Validation ---
    if is_real and current_user.role != 'admin':
        return jsonify({"error": "Forbidden: Only admins can add real transactions."}), 403
    
    # --- VALIDATION ---
    if data.get('transactionType') == 'sell':
        # Calculate current holdings for the symbol
        buys = db.session.query(func.sum(Holding.quantity)).filter_by(symbol=data['symbol'], transaction_type='buy', is_real=True).scalar() or 0
        sells = db.session.query(func.sum(Holding.quantity)).filter_by(symbol=data['symbol'], transaction_type='sell', is_real=True).scalar() or 0
        current_quantity = buys - sells
        
        # Check if the sale is possible
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

    def create_transaction_instance():
        # The frontend now always provides quantity and price for real transactions.
        # The 'purchase_type' field is no longer needed for logic.
        instance = Holding(
            symbol=data['symbol'],
            long_name=long_name,
            sector=sector,
            is_real=data['isReal'],
            purchase_type='quantity', # Hardcode to 'quantity'
            quantity=data.get('quantity'),
            price=data.get('price'),
            dollar_value=data.get('dollarValue'),
            date=data.get('date'),
            custom_section=data.get('customSection', sector or 'Default'),
            transaction_type=data.get('transactionType', 'buy')
        )
        return instance

    new_transaction = create_transaction_instance()
    
    try:
        db.session.add(new_transaction)
        db.session.commit()
    except ProgrammingError:
        db.session.rollback()
        if add_columns_if_missing():
            db.session.remove()
            transaction_to_retry = create_transaction_instance()
            db.session.add(transaction_to_retry)
            db.session.commit()
            return jsonify(transaction_to_retry.to_dict()), 201
        else:
            return jsonify({"error": "Database schema is out of date and could not be automatically updated."}), 500

    return jsonify(new_transaction.to_dict()), 201

@app.route('/api/transaction/<int:transaction_id>', methods=['DELETE'])
@login_required
def delete_transaction(transaction_id):
    if current_user.role != 'admin':
        return jsonify({"error": "Forbidden: Only admins can delete transactions."}), 403
    transaction = Holding.query.get(transaction_id)
    if transaction is None: return jsonify({"error": "Transaction not found"}), 404
    db.session.delete(transaction)
    db.session.commit()
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
    
    # Find all transactions for the given symbol and update their section
    transactions_to_update = Holding.query.filter_by(symbol=symbol).all()
    if not transactions_to_update:
        return jsonify({"error": "No holdings found for this symbol"}), 404
        
    for t in transactions_to_update:
        t.custom_section = new_section
        
    db.session.commit()
    return jsonify({"message": f"Section for {symbol} updated to {new_section}"})

# Presentations
@app.route('/api/presentations', methods=['GET'])
@login_required
def get_presentations():
    try:
        presentations = Presentation.query.order_by(Presentation.created_at.desc()).all()
        return jsonify([p.to_dict() for p in presentations])
    except ProgrammingError:
        db.session.rollback()
        if add_columns_if_missing():
            presentations = Presentation.query.order_by(Presentation.created_at.desc()).all()
            return jsonify([p.to_dict() for p in presentations])
        else:
            return jsonify({"error": "Database schema out of date."}), 500


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
    
    new_presentation = Presentation(
        title=data['title'], url=data['url'],
        ticker=data['ticker'].upper(), action=data['action'],
        created_at=now,
        voting_ends_at=voting_ends
    )
    db.session.add(new_presentation)
    db.session.commit()
    return jsonify(new_presentation.to_dict()), 201

@app.route('/api/presentations/<int:presentation_id>/vote', methods=['POST'])
@login_required
def vote_on_presentation(presentation_id):
    if current_user.role == 'guest':
        return jsonify({"error": "Guests cannot vote."}), 403
        
    data = request.get_json()
    vote_type = data.get('voteType')
    
    presentation = Presentation.query.get(presentation_id)
    if not presentation:
        return jsonify({"error": "Presentation not found"}), 404
        
    if datetime.utcnow() > presentation.voting_ends_at:
        return jsonify({"error": "Voting for this presentation has closed."}), 403
    
    # Check if the user has already voted
    existing_vote = Vote.query.filter_by(user_id=current_user.id, presentation_id=presentation_id).first()
    if existing_vote:
        return jsonify({"error": "You have already voted on this presentation."}), 409 # 409 Conflict

    if vote_type not in ['for', 'against']:
        return jsonify({"error": "Invalid vote type"}), 400

    # Add the new vote
    new_vote = Vote(user_id=current_user.id, presentation_id=presentation_id, vote_type=vote_type)
    db.session.add(new_vote)

    # Update the presentation's vote count
    if vote_type == 'for':
        presentation.votes_for += 1
    elif vote_type == 'against':
        presentation.votes_against += 1
        
    db.session.commit()
    return jsonify(presentation.to_dict())

# Page Content Management
@app.route('/api/page/<page_name>', methods=['GET'])
def get_page_content(page_name):
    content = PageContent.query.filter_by(page_name=page_name).first()
    if content:
        return jsonify({'content': content.content})
    else:
        # Provide default content if none exists in the DB
        default_content = {
            'about': '<h3 class="text-xl font-semibold mb-4 text-cyan-400">Welcome!</h3><p>This is a dashboard for the Muskingum University Investment Club.</p>',
            'internships': '<p>This section will list relevant internship opportunities. Check back later for updates.</p>'
        }
        return jsonify({'content': default_content.get(page_name, '<p>Content not found.</p>')})

@app.route('/api/page/<page_name>', methods=['POST'])
@login_required
def update_page_content(page_name):
    if current_user.role != 'admin':
        return jsonify({"error": "Forbidden: Only admins can edit page content."}), 403
    data = request.get_json()
    new_content = data.get('content')
    
    page = PageContent.query.filter_by(page_name=page_name).first()
    if page:
        page.content = new_content
    else:
        page = PageContent(page_name=page_name, content=new_content)
        db.session.add(page)
        
    db.session.commit()
    return jsonify({'message': f'{page_name} content updated successfully.'})


if __name__ == '__main__':
    # Use a different port if needed, e.g., app.run(debug=True, port=5001)
    app.run(debug=True)
