# app.py
from flask import Flask, jsonify, render_template, request
from flask_sqlalchemy import SQLAlchemy
import yfinance as yf
import pandas as pd
import os
from sqlalchemy import inspect, text
from sqlalchemy.exc import ProgrammingError

# --- FLASK APP INITIALIZATION ---
db = SQLAlchemy()
app = Flask(__name__, static_folder='static', template_folder='templates')

# --- CONFIGURATION ---
database_url = os.environ.get('DATABASE_URL')
if database_url and database_url.startswith("postgres://"):
    database_url = database_url.replace("postgres://", "postgresql://", 1)
app.config['SQLALCHEMY_DATABASE_URI'] = database_url
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False
app.config['SQLALCHEMY_ENGINE_OPTIONS'] = {'pool_pre_ping': True}

# --- DATABASE INIT ---
db.init_app(app)

# --- DATABASE MODELS ---
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

# --- HELPER FUNCTIONS ---
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

# --- DB CREATION ---
with app.app_context():
    db.create_all()

# --- ROUTES ---
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/stock/<ticker_symbol>')
def get_stock_data(ticker_symbol):
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
def get_quotes():
    data = request.get_json()
    tickers_str = " ".join(data.get('tickers', []))
    if not tickers_str: return jsonify({})
    tickers = yf.Tickers(tickers_str)
    quotes = {ts: {'currentPrice': t.info.get('regularMarketPrice'), 'previousClose': t.info.get('previousClose'), 'sector': t.info.get('sector', 'N/A')} for ts, t in tickers.tickers.items()}
    return jsonify(quotes)

@app.route('/api/portfolio', methods=['GET'])
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
def delete_holding(holding_id):
    holding = Holding.query.get(holding_id)
    if holding is None: return jsonify({"error": "Holding not found"}), 404
    db.session.delete(holding)
    db.session.commit()
    return jsonify({"message": "Holding deleted successfully"})

@app.route('/api/presentations', methods=['GET'])
def get_presentations():
    presentations = Presentation.query.order_by(Presentation.id.desc()).all()
    return jsonify([p.to_dict() for p in presentations])

@app.route('/api/presentations', methods=['POST'])
def add_presentation():
    data = request.get_json()
    if not all(k in data for k in ['title', 'url', 'ticker', 'action']):
        return jsonify({"error": "Missing required fields"}), 400
    new_presentation = Presentation(title=data['title'], url=data['url'], ticker=data['ticker'].upper(), action=data['action'])
    db.session.add(new_presentation)
    db.session.commit()
    return jsonify(new_presentation.to_dict()), 201

@app.route('/api/presentations/<int:presentation_id>/vote', methods=['POST'])
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
