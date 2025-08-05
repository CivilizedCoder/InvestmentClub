// static/script.js
document.addEventListener('DOMContentLoaded', () => {
    // --- GLOBAL STATE ---
    let stockChart;
    let currentStockData = null;
    let portfolio = [];
    let recentSearches = [];
    const MAX_RECENT_SEARCHES = 5;
    let holdingToDeleteId = null;

    // --- INITIALIZATION ---
    async function initialize() {
        initializeEventListeners();
        await fetchPortfolio();
        renderPortfolioSummary();
        activateTab('home');
    }

    // --- EVENT LISTENERS ---
    function initializeEventListeners() {
        document.getElementById('fetchBtn')?.addEventListener('click', executeSearch);
        document.getElementById('tickerInput')?.addEventListener('keypress', e => e.key === 'Enter' && executeSearch());
        document.getElementById('presentationForm')?.addEventListener('submit', handlePresentationSubmit);

        document.querySelectorAll('.nav-link').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                activateTab(link.dataset.tab);
            });
        });

        document.getElementById('modalCancelBtn')?.addEventListener('click', () => hideConfirmationModal());
        document.getElementById('modalConfirmBtn')?.addEventListener('click', () => confirmDelete());

        document.querySelector('main').addEventListener('click', (e) => {
            const deleteButton = e.target.closest('.delete-btn');
            if (deleteButton) {
                e.stopPropagation();
                promptForDelete(parseInt(deleteButton.dataset.id, 10));
                return;
            }

            const card = e.target.closest('.summary-card');
            if (card && card.dataset.symbol) {
                document.getElementById('tickerInput').value = card.dataset.symbol;
                executeSearch();
                return;
            }

            const collapsibleHeader = e.target.closest('.collapsible-header');
            if (collapsibleHeader) {
                const content = collapsibleHeader.nextElementSibling;
                collapsibleHeader.classList.toggle('open');
                content.classList.toggle('open');
            }
        });

        document.getElementById('portfolioContent')?.addEventListener('click', (e) => {
            if (e.target.id === 'addSectionBtn') {
                const sectionName = prompt("Enter new section name:");
                if (sectionName && sectionName.trim()) {
                    renderPortfolioDashboard(sectionName.trim());
                }
            }
        });
    }

    // --- NAVIGATION & TAB CONTROL ---
    function activateTab(tab) {
        document.querySelectorAll('.nav-link').forEach(lnk => lnk.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active-content'));

        document.querySelector(`.nav-link[data-tab="${tab}"]`)?.classList.add('active');
        const targetContent = document.getElementById(`${tab}Content`);
        if (targetContent) {
            targetContent.classList.add('active-content');
        }
        
        switch (tab) {
            case 'home': renderPortfolioSummary(); break;
            case 'search': renderSearchTab(); break;
            case 'portfolio': renderPortfolioDashboard(); break;
            case 'transactions': renderTransactionHistory(); break;
            case 'presentations': renderPresentations(); break;
            case 'internships': /* No dynamic render needed */ break;
        }
    }

    // --- STOCK SEARCH ---
    function executeSearch() {
        const ticker = document.getElementById('tickerInput').value.trim().toUpperCase();
        if (!ticker) return;

        if (!recentSearches.includes(ticker)) {
            recentSearches.unshift(ticker);
            if (recentSearches.length > MAX_RECENT_SEARCHES) recentSearches.pop();
        }

        activateTab('search');
        fetchStockData(ticker);
    }

    function fetchStockData(ticker) {
        renderSearchTab(null, null, true); 
        fetch(`/api/stock/${ticker}`)
            .then(response => response.ok ? response.json() : response.json().then(err => { throw new Error(err.error) }))
            .then(data => {
                currentStockData = data;
                renderSearchTab(data);
            })
            .catch(error => renderSearchTab(null, error.message));
    }
    
    // --- DATABASE & PORTFOLIO LOGIC ---
    async function fetchPortfolio() {
        try {
            const response = await fetch('/api/portfolio');
            if (!response.ok) throw new Error('Failed to fetch portfolio');
            portfolio = await response.json();
        } catch (error) {
            console.error("Fetch portfolio error:", error);
            portfolio = [];
        }
    }

    async function addStockToPortfolio() {
        if (!currentStockData) return;
        const isReal = document.getElementById('isRealCheckbox').checked;
        
        const newHolding = {
            symbol: currentStockData.info.symbol,
            longName: currentStockData.info.longName,
            isReal: isReal,
            price: currentStockData.market_data.currentPrice,
            sector: currentStockData.info.sector || 'Other'
        };

        if (isReal) {
            const purchaseType = document.querySelector('input[name="purchaseType"]:checked').value;
            newHolding.purchaseType = purchaseType;
            newHolding.date = document.getElementById('purchaseDate').value;

            if (purchaseType === 'quantity') {
                newHolding.quantity = parseFloat(document.getElementById('purchaseQuantity').value);
                newHolding.price = parseFloat(document.getElementById('purchasePrice').value);
                if (isNaN(newHolding.quantity) || isNaN(newHolding.price) || !newHolding.date) {
                    alert("Please fill in all purchase details."); return;
                }
                newHolding.dollarValue = newHolding.quantity * newHolding.price;
            } else {
                newHolding.dollarValue = parseFloat(document.getElementById('purchaseValue').value);
                if (isNaN(newHolding.dollarValue) || !newHolding.date) {
                    alert("Please fill in dollar value and date."); return;
                }
                if (newHolding.price > 0) {
                    newHolding.quantity = newHolding.dollarValue / newHolding.price;
                } else {
                    newHolding.quantity = 0;
                }
            }
        }

        const response = await fetch('/api/portfolio', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newHolding) });
        if (response.ok) {
            const addedHolding = await response.json();
            portfolio.push(addedHolding);
            alert(`${newHolding.symbol} has been added.`);
            activateTab('portfolio');
        } else {
            alert("Failed to add holding.");
        }
    }

    function promptForDelete(id) {
        holdingToDeleteId = id;
        showConfirmationModal();
    }

    async function confirmDelete() {
        if (holdingToDeleteId === null) return;
        try {
            const response = await fetch(`/api/portfolio/${holdingToDeleteId}`, { method: 'DELETE' });
            if (response.ok) {
                portfolio = portfolio.filter(h => h.id !== holdingToDeleteId);
                const currentTab = document.querySelector('.nav-link.active')?.dataset.tab;
                if (currentTab) activateTab(currentTab);
            } else {
                alert(`Failed to delete: ${(await response.json()).error}`);
            }
        } catch (error) {
            console.error("Error deleting holding:", error);
        } finally {
            hideConfirmationModal();
            holdingToDeleteId = null;
        }
    }

    async function updateHoldingSection(holdingId, newSection) {
        const holding = portfolio.find(h => h.id === holdingId);
        if (holding) holding.customSection = newSection;

        await fetch('/api/portfolio/section', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: holdingId, section: newSection })
        });
    }
    
    // --- RENDER FUNCTIONS ---
    function renderSearchTab(data = null, error = null, isLoading = false) {
        const searchContent = document.getElementById('searchContent');
        const formatCurrency = (val) => val != null ? `$${Number(val).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'N/A';
        const formatLargeNumber = (val) => val != null ? Number(val).toLocaleString() : 'N/A';
        const formatPercent = (val) => val != null ? `${(val * 100).toFixed(2)}%` : 'N/A';
    
        let contentHtml = `
            <h2 class="text-3xl font-bold mb-4">Stock Search</h2>
            <div class="grid grid-cols-1 lg:grid-cols-4 gap-6">
                <div class="lg:col-span-3" id="stockDataViewWrapper">`;
    
        if (isLoading) {
            contentHtml += `<div class="card"><p class="text-center">Loading...</p></div>`;
        } else if (error) {
            contentHtml += `<div class="card"><p class="text-red-400 text-center">Error: ${error}</p></div>`;
        } else if (data) {
            const { info, market_data, valuation_ratios, profitability, dividends_splits, analyst_info, ownership, news } = data;
            contentHtml += `
                <div class="card mb-6">
                    <div class="flex justify-between items-center">
                        <div><h2 class="text-3xl font-bold">${info.longName || 'N/A'}</h2><p class="text-lg text-gray-400">${info.symbol}</p></div>
                        <div class="text-right"><p class="text-4xl font-bold">${formatCurrency(market_data.currentPrice)}</p></div>
                    </div>
                    <p class="mt-4 text-gray-400">${info.longBusinessSummary || 'No summary available.'}</p>
                </div>
                <div class="card mb-6">
                    <div class="flex space-x-2 mb-4">
                        ${['5D', '1M', '3M', '6M', '1Y', '5Y', 'MAX'].map(t => `<button class="timeframe-btn" data-range="${t}">${t}</button>`).join('')}
                    </div>
                    <div class="chart-container" style="height: 400px;"><canvas id="stockChart"></canvas></div>
                </div>
                ${getAddToPortfolioHtml(info.symbol)}
                <div class="space-y-4 mt-6">
                    ${createCollapsibleSection('Key Statistics', `...`)}
                    ${createCollapsibleSection('Valuation Ratios', `...`)}
                    ${createCollapsibleSection('Ownership', createOwnershipTable(ownership))}
                    ${createCollapsibleSection('News', createNewsList(news))}
                </div>
            `;
        } else {
            contentHtml += `<div class="card"><p class="text-gray-500 text-center">Search for a stock to see details.</p></div>`;
        }
    
        contentHtml += `</div><div class="lg:col-span-1"><div class="card">
            <h3 class="text-xl font-bold mb-4">Recent Searches</h3>
            <ul id="recentSearchesList" class="space-y-2">
                ${recentSearches.length > 0 ? recentSearches.map(t => `<li><a href="#" class="recent-search-link text-cyan-400 hover:underline" data-ticker="${t}">${t}</a></li>`).join('') : `<li class="text-gray-500">No recent searches.</li>`}
            </ul>
        </div></div></div>`;
    
        searchContent.innerHTML = contentHtml;
    
        if (data) {
            // Fill collapsible content dynamically
            const statsContent = `
                <div class="info-grid">
                    ${createKpiItem('Market Cap', formatLargeNumber(data.market_data.marketCap))}
                    ${createKpiItem('Volume', formatLargeNumber(data.market_data.volume))}
                    ${createKpiItem('52-Wk High', formatCurrency(data.market_data.fiftyTwoWeekHigh))}
                    ${createKpiItem('52-Wk Low', formatCurrency(data.market_data.fiftyTwoWeekLow))}
                </div>`;
            const ratiosContent = `
                <div class="info-grid">
                    ${createKpiItem('Trailing P/E', data.valuation_ratios.trailingPE?.toFixed(2) || 'N/A')}
                    ${createKpiItem('Forward P/E', data.valuation_ratios.forwardPE?.toFixed(2) || 'N/A')}
                </div>`;
            document.querySelector('#collapsible-content-key-statistics').innerHTML = statsContent;
            document.querySelector('#collapsible-content-valuation-ratios').innerHTML = ratiosContent;

            setupIndividualStockChart(data.historical);
            
            searchContent.querySelectorAll('.timeframe-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    searchContent.querySelectorAll('.timeframe-btn').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                    updateChartByRange(data.historical, btn.dataset.range);
                });
            });
            searchContent.querySelector('.timeframe-btn[data-range="1Y"]')?.classList.add('active');
            updateChartByRange(data.historical, '1Y');

            // Add to portfolio form listeners
            const isRealCheckbox = document.getElementById('isRealCheckbox');
            const realPurchaseInputs = document.getElementById('realPurchaseInputs');
            const addToPortfolioBtn = document.getElementById('addToPortfolioBtn');
            const valueInputs = document.getElementById('valueInputs');
            const quantityInputs = document.getElementById('quantityInputs');

            isRealCheckbox.addEventListener('change', () => {
                realPurchaseInputs.classList.toggle('hidden', !isRealCheckbox.checked);
                addToPortfolioBtn.textContent = isRealCheckbox.checked ? 'Add Transaction' : 'Add to Watchlist';
            });

            document.querySelectorAll('input[name="purchaseType"]').forEach(radio => {
                radio.addEventListener('change', () => {
                    const isQuantity = radio.value === 'quantity';
                    quantityInputs.classList.toggle('hidden', !isQuantity);
                    valueInputs.classList.toggle('hidden', isQuantity);
                });
            });
            addToPortfolioBtn.addEventListener('click', addStockToPortfolio);
        }
    
        searchContent.querySelectorAll('.recent-search-link').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                document.getElementById('tickerInput').value = e.target.dataset.ticker;
                executeSearch();
            });
        });
    }
    
    function getAddToPortfolioHtml(symbol) {
        const today = new Date().toISOString().split('T')[0];
        return `
            <div class="card mt-6">
                <h3 class="text-xl font-bold mb-4">Add ${symbol} to Portfolio or Watchlist</h3>
                <div class="flex items-center mb-4">
                    <input id="isRealCheckbox" type="checkbox" class="h-4 w-4 rounded border-gray-600 text-cyan-600 focus:ring-cyan-500 bg-gray-700">
                    <label for="isRealCheckbox" class="ml-3 block text-sm font-medium text-gray-300">This is a real holding (a transaction)</label>
                </div>
                <div id="realPurchaseInputs" class="space-y-4 hidden">
                    <div class="flex items-center space-x-6">
                        <label class="flex items-center text-sm cursor-pointer">
                            <input type="radio" name="purchaseType" value="value" class="form-radio" checked>
                            <span class="ml-2">By Dollar Value</span>
                        </label>
                        <label class="flex items-center text-sm cursor-pointer">
                            <input type="radio" name="purchaseType" value="quantity" class="form-radio">
                            <span class="ml-2">By Quantity</span>
                        </label>
                    </div>
                    <div id="valueInputs">
                        <input type="number" step="any" id="purchaseValue" placeholder="Total Dollar Value (e.g., 500)" class="form-input">
                    </div>
                    <div id="quantityInputs" class="hidden">
                        <div class="grid grid-cols-2 gap-4">
                            <input type="number" step="any" id="purchaseQuantity" placeholder="Quantity (e.g., 10)" class="form-input">
                            <input type="number" step="any" id="purchasePrice" placeholder="Price per Share" class="form-input">
                        </div>
                    </div>
                    <div>
                        <label for="purchaseDate" class="block text-sm font-medium text-gray-400 mb-1">Purchase Date</label>
                        <input type="date" id="purchaseDate" value="${today}" class="form-input">
                    </div>
                </div>
                <button id="addToPortfolioBtn" class="button-success w-full mt-4">Add to Watchlist</button>
            </div>
        `;
    }

    function createCollapsibleSection(title, content) {
        const titleId = title.toLowerCase().replace(/\s+/g, '-');
        return `
            <div class="card">
                <div class="collapsible-header">
                    <h3 class="text-xl font-bold">${title}</h3>
                    <i class="fas fa-chevron-right collapsible-icon"></i>
                </div>
                <div class="collapsible-content" id="collapsible-content-${titleId}">
                    ${content}
                </div>
            </div>
        `;
    }

    function createKpiItem(label, value) {
        return `<div class="info-item"><span class="info-label">${label}</span><span class="info-value">${value}</span></div>`;
    }

    function createOwnershipTable(ownership) {
        if (!ownership) return '<p class="text-gray-500">Ownership data not available.</p>';
        let html = '<h4>Major Holders</h4><ul class="list-disc pl-5 mb-4">';
        ownership.major_holders.forEach(holder => {
            html += `<li>${holder['Holder']}: ${holder['Shares']}</li>`;
        });
        html += '</ul><h4>Top Institutional Holders</h4><ul class="list-disc pl-5">';
        ownership.institutional_holders.slice(0, 5).forEach(holder => {
            html += `<li>${holder['Holder']}</li>`;
        });
        html += '</ul>';
        return html;
    }

    function createNewsList(news) {
        if (!news || news.length === 0) return '<p class="text-gray-500">No recent news.</p>';
        let html = '<ul class="space-y-4">';
        news.slice(0, 5).forEach(item => {
            html += `
                <li class="border-b border-gray-700 pb-2">
                    <a href="${item.link}" target="_blank" rel="noopener noreferrer" class="font-semibold hover:text-cyan-400">${item.title}</a>
                    <p class="text-sm text-gray-400">${item.publisher}</p>
                </li>`;
        });
        html += '</ul>';
        return html;
    }

    async function renderPortfolioSummary() {
        // ... (implementation unchanged)
    }

    function renderTransactionHistory() {
        // ... (implementation unchanged)
    }

    async function renderPresentations() {
        // ... (implementation unchanged)
    }

    async function renderPortfolioDashboard(newSectionName = null) {
        // ... (implementation unchanged)
    }

    // --- CHARTING ---
    function setupIndividualStockChart(historicalData) {
        const ctx = document.getElementById('stockChart')?.getContext('2d');
        if (!ctx) return;
        if (stockChart) stockChart.destroy();
        
        stockChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: [],
                datasets: [{
                    label: 'Price',
                    data: [],
                    borderColor: '#22D3EE',
                    backgroundColor: 'rgba(34, 211, 238, 0.1)',
                    fill: true,
                    tension: 0.1,
                    pointRadius: 0,
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: 'index',
                    intersect: false,
                },
                scales: { 
                    x: { type: 'time', time: { unit: 'day' }, grid: { display: false } },
                    y: { grid: { color: 'rgba(255, 255, 255, 0.1)' } }
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: '#1F2937',
                        titleColor: '#E5E7EB',
                        bodyColor: '#E5E7EB',
                        borderColor: '#374151',
                        borderWidth: 1,
                        padding: 10,
                        displayColors: false,
                        callbacks: {
                            title: function(context) {
                                const date = new Date(context[0].parsed.x);
                                return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
                            },
                            label: function(context) {
                                let label = context.dataset.label || '';
                                if (label) {
                                    label += ': ';
                                }
                                if (context.parsed.y !== null) {
                                    label += new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(context.parsed.y);
                                }
                                return label;
                            }
                        }
                    }
                }
            }
        });
    }

    function updateChartByRange(historicalData, range) {
        if (!stockChart || !historicalData || historicalData.length === 0) return;

        const now = new Date();
        let startDate = new Date();
        
        switch (range) {
            case '5D': startDate.setDate(now.getDate() - 5); break;
            case '1M': startDate.setMonth(now.getMonth() - 1); break;
            case '3M': startDate.setMonth(now.getMonth() - 3); break;
            case '6M': startDate.setMonth(now.getMonth() - 6); break;
            case '1Y': startDate.setFullYear(now.getFullYear() - 1); break;
            case '5Y': startDate.setFullYear(now.getFullYear() - 5); break;
            case 'MAX': startDate = new Date(historicalData[0].Date); break;
        }

        const filteredData = historicalData.filter(d => new Date(d.Date) >= startDate);
        
        stockChart.data.labels = filteredData.map(d => d.Date);
        stockChart.data.datasets[0].data = filteredData.map(d => d.Close);
        stockChart.update();
    }

    // ... other functions like handlePresentationSubmit, handleVote, etc.

    // --- START THE APP ---
    initialize();
});
