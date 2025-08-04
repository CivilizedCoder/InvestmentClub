# app.py
from flask import Flask, jsonify, render_template, request
from flask_sqlalchemy import SQLAlchemy
import yfinance as yf
import os

# Initialize the SQLAlchemy database extension WITHOUT an app instance.
db = SQLAlchemy()

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
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

# Add engine options to enable connection pooling pre-ping.
# This helps prevent errors from stale connections in the pool.
app.config['SQLALCHEMY_ENGINE_OPTIONS'] = {
    'pool_pre_ping': True
}

# Now, associate the database with the app instance.
db.init_app(app)

# --- DATABASE MODEL ---
class Holding(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    symbol = db.Column(db.String(10), nullable=False)
    long_name = db.Column(db.String(100), nullable=False)
    is_real = db.Column(db.Boolean, nullable=False)
    purchase_type = db.Column(db.String(20))
    quantity = db.Column(db.Float)
    price = db.Column(db.Float)
    dollar_value = db.Column(db.Float)
    date = db.Column(db.String(20))

    def to_dict(self):
        return {
            'id': self.id, 'symbol': self.symbol, 'longName': self.long_name,
            'isReal': self.is_real, 'purchaseType': self.purchase_type,
            'quantity': self.quantity, 'price': self.price,
            'dollarValue': self.dollar_value, 'date': self.date
        }

# Create the database table within the application context
with app.app_context():
    db.create_all()

# Teardown function to ensure database sessions are closed after each request.
@app.teardown_appcontext
def shutdown_session(exception=None):
    db.session.remove()

# --- HTML & API ROUTES ---

@app.route('/')
def index():
    return render_template('index.html')

# NEW: Efficiently fetches current prices for multiple tickers
@app.route('/api/quotes', methods=['POST'])
def get_quotes():
    """Fetches current price for a list of tickers for the portfolio snapshot."""
    try:
        data = request.get_json()
        tickers_str = " ".join(data.get('tickers', []))
        if not tickers_str:
            return jsonify({})

        tickers = yf.Tickers(tickers_str)
        
        quotes = {}
        # The yf.Tickers object is a dictionary-like object.
        for ticker_symbol, ticker_obj in tickers.tickers.items():
            # yfinance can be inconsistent, so we access info safely
            info = ticker_obj.info
            quotes[ticker_symbol] = {
                'currentPrice': info.get('regularMarketPrice'),
                'previousClose': info.get('previousClose')
            }
        return jsonify(quotes)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/stock/<ticker_symbol>')
def get_stock_data(ticker_symbol):
    try:
        stock = yf.Ticker(ticker_symbol)
        info = stock.info
        if not info or 'regularMarketPrice' not in info or info.get('regularMarketPrice') is None:
            return jsonify({"error": "Invalid ticker or data not available"}), 404
        hist = stock.history(period="max").reset_index()
        hist['Date'] = hist['Date'].dt.strftime('%Y-%m-%d')
        data = {
            'symbol': info.get('symbol'), 'longName': info.get('longName'),
            'currentPrice': info.get('regularMarketPrice'), 'dayHigh': info.get('dayHigh'),
            'dayLow': info.get('dayLow'), 'marketCap': info.get('marketCap'),
            'volume': info.get('volume'), 'fiftyTwoWeekHigh': info.get('fiftyTwoWeekHigh'),
            'fiftyTwoWeekLow': info.get('fiftyTwoWeekLow'), 'forwardPE': info.get('forwardPE'),
            'historical': hist[['Date', 'Close']].to_dict('records')
        }
        return jsonify(data)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/portfolio_data', methods=['POST'])
def get_portfolio_data():
    try:
        data = request.get_json()
        tickers = data.get('tickers')
        if not tickers: return jsonify({"error": "No tickers provided"}), 400
        portfolio_data = yf.download(tickers, period="5y")
        if portfolio_data.empty: return jsonify({"error": "Could not fetch data"}), 404
        close_prices = portfolio_data['Close']
        df = close_prices.to_frame(name=tickers[0]) if len(tickers) == 1 else close_prices
        df = df.dropna()
        df.index = df.index.strftime('%Y-%m-%d')
        return df.to_json(orient='index')
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# --- DATABASE API ENDPOINTS ---

@app.route('/api/portfolio', methods=['GET'])
def get_holdings():
    holdings = Holding.query.all()
    return jsonify([h.to_dict() for h in holdings])

@app.route('/api/portfolio', methods=['POST'])
def add_holding():
    data = request.get_json()
    new_holding = Holding(
        symbol=data['symbol'], long_name=data['longName'], is_real=data['isReal'],
        purchase_type=data.get('purchaseType'), quantity=data.get('quantity'),
        price=data.get('price'), dollar_value=data.get('dollarValue'), date=data.get('date')
    )
    db.session.add(new_holding)
    db.session.commit()
    return jsonify(new_holding.to_dict()), 201

@app.route('/api/portfolio/<int:holding_id>', methods=['DELETE'])
def delete_holding(holding_id):
    holding = Holding.query.get(holding_id)
    if holding is None:
        return jsonify({"error": "Holding not found"}), 404
    db.session.delete(holding)
    db.session.commit()
    return jsonify({"message": "Holding deleted successfully"})

if __name__ == '__main__':
    app.run(debug=True)
