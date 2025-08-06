# app.py
from flask import Flask, jsonify, render_template, request
from flask_sqlalchemy import SQLAlchemy
import yfinance as yf
import pandas as pd
import os
from sqlalchemy import inspect, text
from sqlalchemy.exc import ProgrammingError
import math
from datetime import datetime, timedelta

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
app.config['SQLALCHEMY_ENGINE_OPTIONS'] = { 'pool_pre_ping': True }

# Now, associate the database with the app instance.
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
    price = db.Column(db.Float) # Price per share at purchase
    dollar_value = db.Column(db.Float) # Total cost at purchase
    date = db.Column(db.String(20))
    custom_section = db.Column(db.String(100), nullable=True, default='Default')


    def to_dict(self):
        return {
            'id': self.id, 'symbol': self.symbol, 'longName': self.long_name,
            'sector': self.sector, 'isReal': self.is_real, 
            'purchaseType': self.purchase_type, 'quantity': self.quantity, 
            'price': self.price, 'dollarValue': self.dollar_value, 'date': self.date,
            'customSection': self.custom_section
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

    def to_dict(self, role='guest'):
        is_voting_open = datetime.utcnow() < self.voting_ends_at
        
        presentation_dict = {
            'id': self.id,
            'title': self.title,
            'url': self.url,
            'ticker': self.ticker,
            'action': self.action,
            'votingEndsAt': self.voting_ends_at.isoformat() + 'Z', # ISO format for JS
            'isVotingOpen': is_voting_open
        }

        # Admins see votes anytime. Members only see votes after the period is closed.
        if role == 'admin' or not is_voting_open:
            presentation_dict['votesFor'] = self.votes_for
            presentation_dict['votesAgainst'] = self.votes_against
        
        return presentation_dict

class PageContent(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    page_name = db.Column(db.String(50), unique=True, nullable=False)
    content = db.Column(db.Text, nullable=False)

# Create the database tables within the application context
with app.app_context():
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

# --- HTML & API ROUTES ---
@app.route('/')
def index():
    return render_template('index.html')

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

@app.route('/api/portfolio', methods=['GET'])
def get_holdings():
    try:
        holdings = Holding.query.all()
        return jsonify([h.to_dict() for h in holdings])
    except ProgrammingError:
        add_columns_if_missing()
        return jsonify([])


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
            dollar_value=data.get('dollarValue'), date=data.get('date'),
            custom_section=data.get('customSection', sector or 'Default')
        )
        if data.get('purchaseType') == 'value' and data.get('price') and data['price'] > 0:
            instance.quantity = data['dollarValue'] / data['price']
        return instance

    new_holding = create_holding_instance()
    
    try:
        db.session.add(new_holding)
        db.session.commit()
    except ProgrammingError:
        db.session.rollback()
        if add_columns_if_missing():
            db.session.remove()
            holding_to_retry = create_holding_instance()
            db.session.add(holding_to_retry)
            db.session.commit()
            return jsonify(holding_to_retry.to_dict()), 201
        else:
            return jsonify({"error": "Database schema is out of date and could not be automatically updated."}), 500

    return jsonify(new_holding.to_dict()), 201

@app.route('/api/portfolio/<int:holding_id>', methods=['DELETE'])
def delete_holding(holding_id):
    holding = Holding.query.get(holding_id)
    if holding is None: return jsonify({"error": "Holding not found"}), 404
    db.session.delete(holding)
    db.session.commit()
    return jsonify({"message": "Holding deleted successfully"})

@app.route('/api/portfolio/section', methods=['POST'])
def update_holding_section():
    data = request.get_json()
    holding_id = data.get('id')
    new_section = data.get('section')
    
    holding = Holding.query.get(holding_id)
    if not holding:
        return jsonify({"error": "Holding not found"}), 404
        
    holding.custom_section = new_section
    db.session.commit()
    return jsonify(holding.to_dict())

# Presentations
@app.route('/api/presentations', methods=['GET'])
def get_presentations():
    role = request.args.get('role', 'guest')
    try:
        presentations = Presentation.query.order_by(Presentation.id.desc()).all()
        return jsonify([p.to_dict(role=role) for p in presentations])
    except ProgrammingError:
        db.session.rollback()
        if add_columns_if_missing():
            presentations = Presentation.query.order_by(Presentation.id.desc()).all()
            return jsonify([p.to_dict(role=role) for p in presentations])
        else:
            return jsonify({"error": "Database schema out of date."}), 500


@app.route('/api/presentations', methods=['POST'])
def add_presentation():
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
    return jsonify(new_presentation.to_dict(role='admin')), 201

@app.route('/api/presentations/<int:presentation_id>/vote', methods=['POST'])
def vote_on_presentation(presentation_id):
    data = request.get_json()
    vote_type = data.get('voteType')
    
    presentation = Presentation.query.get(presentation_id)
    if not presentation:
        return jsonify({"error": "Presentation not found"}), 404
        
    if datetime.utcnow() > presentation.voting_ends_at:
        return jsonify({"error": "Voting for this presentation has closed."}), 403
        
    if vote_type == 'for':
        presentation.votes_for += 1
    elif vote_type == 'against':
        presentation.votes_against += 1
    else:
        return jsonify({"error": "Invalid vote type"}), 400
        
    db.session.commit()
    return jsonify(presentation.to_dict(role='admin'))

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
def update_page_content(page_name):
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
    app.run(debug=True)
