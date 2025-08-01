# Add render_template to your imports
from flask import Flask, jsonify, render_template
from flask_cors import CORS
import yfinance as yf

# Tell Flask where to find the HTML and JS files
app = Flask(__name__,
            static_folder='static',
            template_folder='templates')

# You can remove CORS now since everything is served from the same domain
# CORS(app)

# NEW: Route to serve the frontend HTML file
@app.route('/')
def index():
    return render_template('index.html')

# EXISTING: Your API route for stock data
@app.route('/api/stock/<ticker_symbol>')
def get_stock_data(ticker_symbol):
    """
    Fetches key statistics for a given stock ticker from Yahoo Finance.
    """
    try:
        stock = yf.Ticker(ticker_symbol)
        info = stock.info

        if not info or 'regularMarketPrice' not in info or info['regularMarketPrice'] is None:
            return jsonify({"error": "Invalid ticker or data not available"}), 404

        data = {
            'symbol': info.get('symbol'),
            'longName': info.get('longName'),
            'currentPrice': info.get('regularMarketPrice'),
            'dayHigh': info.get('dayHigh'),
            'dayLow': info.get('dayLow'),
            'marketCap': info.get('marketCap'),
            'volume': info.get('volume')
        }
        return jsonify(data)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# This part is only for local testing
if __name__ == '__main__':
    app.run(debug=True)