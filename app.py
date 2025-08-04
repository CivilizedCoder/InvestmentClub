# app.py
from flask import Flask, jsonify, render_template, request
from flask_sqlalchemy import SQLAlchemy
import yfinance as yf
import pandas as pd
import os
from sqlalchemy import inspect, text
from sqlalchemy.exc import ProgrammingError
from werkzeug.security import generate_password_hash, check_password_hash
from flask_login import LoginManager, UserMixin, login_user, logout_user, login_required, current_user
from functools import wraps

# --- FLASK APP INITIALIZATION ---
db = SQLAlchemy()
login_manager = LoginManager()
app = Flask(__name__, static_folder='static', template_folder='templates')

# --- CONFIGURATION ---
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'a-super-secret-key-that-should-be-changed')
database_url = os.environ.get('DATABASE_URL')
if database_url and database_url.startswith("postgres://"):
    database_url = database_url.replace("postgres://", "postgresql://", 1)
app.config['SQLALCHEMY_DATABASE_URI'] = database_url
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['SQLALCHEMY_ENGINE_OPTIONS'] = {'pool_pre_ping': True}

# --- DATABASE & LOGIN MANAGER INIT ---
db.init_app(app)
login_manager.init_app(app)
login_manager.login_view = 'login_page' # Redirect to a conceptual login page if unauthorized

# --- DATABASE MODELS ---
class User(UserMixin, db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    password_hash = db.Column(db.String(200), nullable=False)
    role = db.Column(db.String(20), nullable=False, default='guest') # Roles: guest, member, admin

    def set_password(self, password):
        self.password_hash = generate_password_hash(password)

    def check_password(self, password):
        return check_password_hash(self.password_hash, password)

class Holding(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    symbol = db.Column(db.String(10), nullable=False)
    long_name = db.Column(db.String(100), nullable=False)
    sector = db.Column(db.String(50), nullable=True)
    is_real = db.Column(db.Boolean, nullable=False)
    purchase_type = db.Column(db.String(20))
    quantity = db.Column(db.Float)
    price = db.Column(db.Float)
    dollar_value = db.Column(db.Float)
    date = db.Column(db.String(20))

    def to_dict(self):
        return {
            'id': self.id, 'symbol': self.symbol, 'longName': self.long_name,
            'sector': self.sector, 'isReal': self.is_real, 
            'purchaseType': self.purchase_type, 'quantity': self.quantity, 
            'price': self.price, 'dollarValue': self.dollar_value, 'date': self.date
        }

class Presentation(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    title = db.Column(db.String(200), nullable=False)
    url = db.Column(db.String(500), nullable=False)
    ticker = db.Column(db.String(10), nullable=False)
    action = db.Column(db.String(10), nullable=False)
    votes_for = db.Column(db.Integer, default=0)
    votes_against = db.Column(db.Integer, default=0)

    def to_dict(self):
        return {
            'id': self.id, 'title': self.title, 'url': self.url,
            'ticker': self.ticker, 'action': self.action,
            'votesFor': self.votes_for, 'votesAgainst': self.votes_against
        }

# --- PERMISSION DECORATORS ---
def role_required(role):
    def decorator(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            if not current_user.is_authenticated:
                return jsonify({"error": "Authentication required"}), 401
            # Admin has access to everything
            if current_user.role == 'admin':
                return f(*args, **kwargs)
            # Check if user role is sufficient
            if current_user.role != role and role == 'member':
                 return jsonify({"error": "Insufficient permissions"}), 403
            if current_user.role != role and role == 'admin':
                 return jsonify({"error": "Administrator access required"}), 403
            return f(*args, **kwargs)
        return decorated_function
    return decorator

# --- HELPER FUNCTIONS ---
@login_manager.user_loader
def load_user(user_id):
    return User.query.get(int(user_id))

def add_sector_column_if_missing():
    try:
        inspector = inspect(db.engine)
        columns = [c['name'] for c in inspector.get_columns('holding')]
        if 'sector' not in columns:
            with db.engine.connect().execution_options(isolation_level="AUTOCOMMIT") as connection:
                connection.execute(text('ALTER TABLE holding ADD COLUMN sector VARCHAR(50)'))
            return True
    except Exception as e:
        print(f"CRITICAL: Failed to execute migration for 'sector' column: {e}")
    return False

# --- DB CREATION AND ADMIN USER SETUP ---
with app.app_context():
    db.create_all()
    if not User.query.filter_by(username='timymelon').first():
        print("Creating default admin user...")
        admin_user = User(username='timymelon', role='admin')
        admin_user.set_password('luvm3l0ns')
        db.session.add(admin_user)
        db.session.commit()
        print("Admin user 'timymelon' created.")

# --- ROUTES ---
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/login', methods=['POST'])
def login():
    data = request.get_json()
    user = User.query.filter_by(username=data.get('username')).first()
    if user and user.check_password(data.get('password')):
        login_user(user)
        return jsonify({"username": user.username, "role": user.role})
    return jsonify({"error": "Invalid username or password"}), 401

@app.route('/api/logout', methods=['POST'])
@login_required
def logout():
    logout_user()
    return jsonify({"message": "Logged out successfully"})

@app.route('/api/session')
def get_session():
    if current_user.is_authenticated:
        return jsonify({"username": current_user.username, "role": current_user.role})
    return jsonify({}), 401 # No active session

@app.route('/api/stock/<ticker_symbol>')
def get_stock_data(ticker_symbol):
    # This remains public
    try:
        stock = yf.Ticker(ticker_symbol)
        info = stock.info
        if not info or 'regularMarketPrice' not in info:
            return jsonify({"error": "Invalid ticker or data not available"}), 404
        hist = stock.history(period="max").reset_index()
        hist['Date'] = hist['Date'].dt.strftime('%Y-%m-%d')
        data = {
            'symbol': info.get('symbol'), 'longName': info.get('longName'),
            'sector': info.get('sector', 'Other'), 'currentPrice': info.get('regularMarketPrice'),
            'dayHigh': info.get('dayHigh'), 'dayLow': info.get('dayLow'), 'marketCap': info.get('marketCap'),
            'volume': info.get('volume'), 'fiftyTwoWeekHigh': info.get('fiftyTwoWeekHigh'),
            'fiftyTwoWeekLow': info.get('fiftyTwoWeekLow'), 'forwardPE': info.get('forwardPE'),
            'historical': hist[['Date', 'Close']].to_dict('records')
        }
        return jsonify(data)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/quotes', methods=['POST'])
@login_required
def get_quotes():
    # Protected: only logged-in users can get quotes for the portfolio summary
    data = request.get_json()
    tickers_str = " ".join(data.get('tickers', []))
    if not tickers_str: return jsonify({})
    tickers = yf.Tickers(tickers_str)
    quotes = {ts: {'currentPrice': t.info.get('regularMarketPrice'), 'previousClose': t.info.get('previousClose'), 'sector': t.info.get('sector', 'N/A')} for ts, t in tickers.tickers.items()}
    return jsonify(quotes)

@app.route('/api/portfolio', methods=['GET'])
@login_required
@role_required('member')
def get_holdings():
    try:
        holdings = Holding.query.all()
        return jsonify([h.to_dict() for h in holdings])
    except ProgrammingError as e:
        if 'column "sector" of relation "holding" does not exist' in str(e):
            add_sector_column_if_missing()
            return jsonify([])
        raise e

@app.route('/api/portfolio', methods=['POST'])
@login_required
@role_required('admin')
def add_holding():
    data = request.get_json()
    try:
        stock_info = yf.Ticker(data['symbol']).info
        sector = stock_info.get('sector', 'Other')
        long_name = stock_info.get('longName', data['longName'])
    except Exception:
        sector = 'Other'
        long_name = data['longName']

    def create_holding_instance():
        instance = Holding(
            symbol=data['symbol'], long_name=long_name, sector=sector,
            is_real=data['isReal'], purchase_type=data.get('purchaseType'),
            quantity=data.get('quantity'), price=data.get('price'),
            dollar_value=data.get('dollarValue'), date=data.get('date')
        )
        if data.get('purchaseType') == 'value' and data.get('price') and data['price'] > 0:
            instance.quantity = data['dollarValue'] / data['price']
        return instance

    new_holding = create_holding_instance()
    try:
        db.session.add(new_holding)
        db.session.commit()
    except ProgrammingError as e:
        db.session.rollback()
        if 'column "sector" of relation "holding" does not exist' in str(e):
            if add_sector_column_if_missing():
                db.session.remove()
                holding_to_retry = create_holding_instance()
                db.session.add(holding_to_retry)
                db.session.commit()
                return jsonify(holding_to_retry.to_dict()), 201
            else:
                return jsonify({"error": "Database schema is out of date and could not be updated."}), 500
        else:
            raise e
    return jsonify(new_holding.to_dict()), 201

@app.route('/api/portfolio/<int:holding_id>', methods=['DELETE'])
@login_required
@role_required('admin')
def delete_holding(holding_id):
    holding = Holding.query.get(holding_id)
    if holding is None: return jsonify({"error": "Holding not found"}), 404
    db.session.delete(holding)
    db.session.commit()
    return jsonify({"message": "Holding deleted successfully"})

@app.route('/api/presentations', methods=['GET'])
@login_required
@role_required('member')
def get_presentations():
    presentations = Presentation.query.order_by(Presentation.id.desc()).all()
    return jsonify([p.to_dict() for p in presentations])

@app.route('/api/presentations', methods=['POST'])
@login_required
@role_required('member')
def add_presentation():
    data = request.get_json()
    if not all(k in data for k in ['title', 'url', 'ticker', 'action']):
        return jsonify({"error": "Missing required fields"}), 400
    new_presentation = Presentation(title=data['title'], url=data['url'], ticker=data['ticker'].upper(), action=data['action'])
    db.session.add(new_presentation)
    db.session.commit()
    return jsonify(new_presentation.to_dict()), 201

@app.route('/api/presentations/<int:presentation_id>/vote', methods=['POST'])
@login_required
@role_required('member')
def vote_on_presentation(presentation_id):
    data = request.get_json()
    vote_type = data.get('voteType')
    presentation = Presentation.query.get(presentation_id)
    if not presentation:
        return jsonify({"error": "Presentation not found"}), 404
    if vote_type == 'for':
        presentation.votes_for += 1
    elif vote_type == 'against':
        presentation.votes_against += 1
    else:
        return jsonify({"error": "Invalid vote type"}), 400
    db.session.commit()
    return jsonify(presentation.to_dict())

if __name__ == '__main__':
    app.run(debug=True)
