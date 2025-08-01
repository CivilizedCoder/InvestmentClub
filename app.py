from flask import Flask, jsonify
from flask_cors import CORS
import yfinance as yf

# Initialize the Flask application
app = Flask(__name__)

# IMPORTANT: Enable CORS to allow requests from your GitHub Pages domain.
# Replace '*' with your actual GitHub Pages URL in production for better security.
# e.g., CORS(app, resources={r"/api/*": {"origins": "https://your-username.github.io"}})
CORS(app)

@app.route('/api/stock/<ticker_symbol>')
def get_stock_data(ticker_symbol):
    """
    Fetches key statistics for a given stock ticker from Yahoo Finance.
    """
    try:
        stock = yf.Ticker(ticker_symbol)
        info = stock.info

        # yfinance returns an empty dict for invalid tickers sometimes.
        # We check for a key that should exist, like 'regularMarketPrice'.
        if not info or 'regularMarketPrice' not in info or info['regularMarketPrice'] is None:
            return jsonify({"error": "Invalid ticker or data not available"}), 404

        # Extract only the data you need for the frontend
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
        # Generic error handler for other issues (e.g., network problems)
        return jsonify({"error": str(e)}), 500

# This part is for local testing. Render will use Gunicorn.
if __name__ == '__main__':
    app.run(debug=True)