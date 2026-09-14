# Where these fixtures came from

Recorded on 2026-09-08. Every file except the two Finnhub ones is the untouched body of a
live call made from this machine.

- `edgar-8k-nvda.json`
  `GET https://efts.sec.gov/LATEST/search-index?q=&forms=8-K&ciks=0001045810&startdt=2026-08-09&enddt=2026-09-08`
  with header `User-Agent: Kaaval research ramakrishnanhulk20@gmail.com`. Three 8-K filings.

- `edgar-8k-empty.json`
  The same endpoint with `q="TSLA"&forms=8-K&startdt=2026-08-25&enddt=2026-09-08`. Zero hits,
  which is the reason the adapter searches by CIK instead of by ticker text.

- `sec-company-tickers-subset.json`
  Four rows lifted unchanged from `https://www.sec.gov/files/company_tickers.json`, which is
  10,415 rows and 797 KB in full. The keys and field names are the file's own; only the rows
  Kaaval's tests need were kept.

- `gdelt-tesla.json`
  `GET https://api.gdeltproject.org/api/v2/doc/doc?query=Tesla%20stock&mode=artlist&maxrecords=20&format=json&sort=datedesc&timespan=1d`.
  Twenty articles. The live call needed four attempts: GDELT answered 429 once and the TCP
  connect timed out twice, which is what src/news/http.ts exists to survive.

- `finnhub-company-news.json` and `finnhub-earnings.json`
  Built from the sample responses printed in Finnhub's own API docs, saved at
  `reference/news/source-finnhub.md`. These two are not live recordings: the endpoints need an
  API key and none was issued when the adapter was written. The live Finnhub test in
  `test/news/live.test.ts` runs only when `FINNHUB_API_KEY` is set and checks the real shape.
