document.getElementById('fetchBtn').addEventListener('click', fetchData);

function fetchData() {
    const ticker = document.getElementById('tickerInput').value.trim().toUpperCase();
    const dataContainer = document.getElementById('dataContainer');

    if (!ticker) {
        dataContainer.innerHTML = '<p style="color: red;">Please enter a ticker symbol.</p>';
        return;
    }

    // **CHANGE**: Use a relative path for the API URL
    const apiUrl = `/api/stock/${ticker}`;

    dataContainer.innerHTML = '<p>Loading...</p>';

    fetch(apiUrl)
        .then(response => {
            if (!response.ok) {
                return response.json().then(err => { throw new Error(err.error) });
            }
            return response.json();
        })
        .then(data => {
            dataContainer.innerHTML = `
                <h2>${data.longName} (${data.symbol})</h2>
                <ul>
                    <li><strong>Current Price:</strong> $${data.currentPrice.toLocaleString()}</li>
                    <li><strong>Day High:</strong> $${data.dayHigh.toLocaleString()}</li>
                    <li><strong>Day Low:</strong> $${data.dayLow.toLocaleString()}</li>
                    <li><strong>Volume:</strong> ${data.volume.toLocaleString()}</li>
                    <li><strong>Market Cap:</strong> $${data.marketCap.toLocaleString()}</li>
                </ul>
            `;
        })
        .catch(error => {
            console.error('Fetch Error:', error);
            dataContainer.innerHTML = `<p style="color: red;">Error: ${error.message}. Please try another ticker.</p>`;
        });
}