# app.py
from flask import Flask, jsonify, render_template, request
import yfinance as yf
import pandas as pd

# Initialize the Flask application and tell it where to find the static/template files
app = Flask(__name__,
            static_folder='static',
            template_folder='templates')

@app.route('/')
def index():
    """Serves the main index.html page."""
    return render_template('index.html')

@app.route('/api/stock/<ticker_symbol>')
def get_stock_data(ticker_symbol):
    """
    Fetches detailed statistics and full historical data for a single stock ticker.
    This is used when a user searches for a specific stock.
    """
    try:
        stock = yf.Ticker(ticker_symbol)
        info = stock.info

        # Validate that the ticker exists and has price data
        if not info or 'regularMarketPrice' not in info or info.get('regularMarketPrice') is None:
            return jsonify({"error": "Invalid ticker or data not available"}), 404

        # Fetch the complete price history for the stock
        hist = stock.history(period="max")
        if hist.empty:
             return jsonify({"error": "Historical data not available for this ticker"}), 404

        # Format the date and select the necessary columns
        hist = hist.reset_index()
        hist['Date'] = hist['Date'].dt.strftime('%Y-%m-%d')
        historical_data = hist[['Date', 'Close']].to_dict('records')

        # Compile the data packet to send to the frontend
        data = {
            'symbol': info.get('symbol'),
            'longName': info.get('longName'),
            'currentPrice': info.get('regularMarketPrice'),
            'dayHigh': info.get('dayHigh'),
            'dayLow': info.get('dayLow'),
            'marketCap': info.get('marketCap'),
            'volume': info.get('volume'),
            'fiftyTwoWeekHigh': info.get('fiftyTwoWeekHigh'),
            'fiftyTwoWeekLow': info.get('fiftyTwoWeekLow'),
            'forwardPE': info.get('forwardPE'),
            'historical': historical_data
        }
        return jsonify(data)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/portfolio', methods=['POST'])
def get_portfolio_data():
    """
    Fetches historical data for a list of tickers provided in the request body.
    This is used to build the unified portfolio performance graph.
    """
    try:
        data = request.get_json()
        tickers = data.get('tickers')
        if not tickers:
            return jsonify({"error": "No tickers provided"}), 400

        # Use yfinance's multi-ticker download for efficiency
        # We fetch data for the last 5 years, which is plenty for portfolio analysis
        portfolio_data = yf.download(tickers, period="5y")
        
        if portfolio_data.empty:
            return jsonify({"error": "Could not fetch data for the given tickers"}), 404

        # We only need the 'Close' prices
        close_prices = portfolio_data['Close']
        
        # Handle the case where only one ticker is requested, which changes the dataframe structure
        if len(tickers) == 1:
            # If only one ticker, result is a Series, convert it to a DataFrame
            df = close_prices.to_frame(name=tickers[0])
        else:
            df = close_prices

        # Remove any rows with missing data and format the date index
        df = df.dropna()
        df.index = df.index.strftime('%Y-%m-%d')
        
        # Convert the final dataframe to a JSON object to send to the frontend
        return df.to_json(orient='index')
        
    except Exception as e:
        return jsonify({"error": str(e)}), 500

# This part is for local testing and will not be used on Render
if __name__ == '__main__':
    app.run(debug=True)
