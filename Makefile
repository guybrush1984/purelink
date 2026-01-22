.PHONY: chrome firefox clean

chrome:
	cp manifest.chrome.json manifest.json
	@echo "Built for Chrome"

firefox:
	cp manifest.firefox.json manifest.json
	@echo "Built for Firefox"

clean:
	rm -f manifest.json
