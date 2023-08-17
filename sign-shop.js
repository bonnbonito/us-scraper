const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs-extra');
const path = require('path');
const { extractPlaceID, writeToFile } = require('./inc/helpers');
const { autoScrollMap } = require('./inc/auto-scroll');
const getContactLinks = require('./inc/get-contact-links');
const searchEmails = require('./inc/email-helpers');
const filename = 'west-coast.csv';

const CONFIG = {
    mapUrl: 'https://www.google.com/maps/search/',
    query: 'sign shop',
    inputFilename: filename,
    outputFilename: `./output/sign-shop-${filename}`,
    processedZipsFile: 'processedZips.txt'
};

const processedPlaces = new Set();
let processedZips = new Set();

async function loadprocessedZips() {
    if (fs.existsSync(CONFIG.processedZipsFile)) {
        const content = await fs.promises.readFile(CONFIG.processedZipsFile, 'utf8');
        processedZips = new Set(content.split('\n').map(state => state.trim()));
		console.log(processedZips);
    }
}

async function openPuppeteer(url, queryText) {
    let browser = null;
	let chromeTmpDataDir = null;
    try {
        puppeteer.use(StealthPlugin());
        browser = await puppeteer.launch({
			headless: false,
			args: [ '--ignore-certificate-errors' ] 
		});

		
		let chromeSpawnArgs = browser.process().spawnargs;
		for (let i = 0; i < chromeSpawnArgs.length; i++) {
			if (chromeSpawnArgs[i].indexOf("--user-data-dir=") === 0) {
				chromeTmpDataDir = chromeSpawnArgs[i].replace("--user-data-dir=", "");
				console.log('================================================');
				console.log(chromeTmpDataDir);
				console.log('================================================');
			}
		}

        const page = await browser.newPage();

        await page.setViewport({ width: 1200, height: 3000 });
        await page.goto(url, { waitUntil: 'networkidle0' });

        const results = await parsePlaces( page, queryText );
        
        console.log('===================ParsePlaces================');

        const data = results.length > 0 ? await getPlacesData(results ) : [];

        console.log(data);

    } catch (error) {
        console.error('An error occurred:', error);
        await writeToFile(path.join(__dirname, 'error.log'), `${error.toString()} --- ${url} | openPuppeteer()\n`);
    } finally {
        if (browser) {
            await browser.close();
			if (fs.statSync(chromeTmpDataDir).isDirectory()) {
                // If so, try to delete the folder recursively
                fs.rm(chromeTmpDataDir, { recursive: true, force: true }, (err) => {
                  if (err) {
                    console.error('Error deleting folder:', chromeTmpDataDir, err);
                  } else {
                    console.log('Successfully deleted folder:', chromeTmpDataDir);
                  }
                });
              }
        }
    }
}


async function parsePlaces(page, queryText) {
    let links;

	await page.waitForSelector('#searchboxinput');

	const searchInput = await page.$('#searchboxinput');

	await searchInput.click({ clickCount: 3 })

	await searchInput.type('sign shop ' + queryText );

	await page.keyboard.press('Enter');

	await page.waitForNavigation();

	await page.waitForSelector('[role="feed"]');

    const hasFeed = await page.evaluate(() => {
        const feed = document.querySelector('[role="feed"]');
        return !!feed;
    });

    if (hasFeed) {
        await autoScrollMap(page)
        .then((data) => {
        console.log("Scrolling finished");
		links = data;
        });
    }

    if (!links || links.length === 0) {
        console.log("No links");
        await page.click('#searchbox-searchbutton');
        links = [page.url()];
    }

    return links;
}


async function getPlacesData( links ) {

	const query = "sign shop";

	console.log('Found ' + links.length + ' places');

	// Iterate through each link and click on it sequentially
	for (const link of links) {
		let chromeTmpDataDir = null;
        console.log(link);
		const placeID = extractPlaceID(link);

		// If the place has been processed before, skip it
		if (processedPlaces.has(placeID)) {
            console.log('!!!!!!!!! ========= ALREADY EXISTS ========== !!!!!!!!');
			continue;
		}

       

		// Add the placeID to the set of processed places
		processedPlaces.add(placeID);
		console.log('Extracting data from placeID ', link);

		let browser;
		try {
			puppeteer.use(StealthPlugin());
			browser = await puppeteer.launch({ 
				headless: false,
				args: [ '--ignore-certificate-errors' ] 
			});

			
			let chromeSpawnArgs = browser.process().spawnargs;
			for (let i = 0; i < chromeSpawnArgs.length; i++) {
				if (chromeSpawnArgs[i].indexOf("--user-data-dir=") === 0) {
					chromeTmpDataDir = chromeSpawnArgs[i].replace("--user-data-dir=", "");
					console.log('=================GET PLACES DATA=======================');
					console.log(chromeTmpDataDir);
					console.log('================================================');
				}
			}

			page = await browser.newPage();

			page.on('dialog', async dialog => {
				await dialog.accept();
			});

			await page.goto(link, { waitUntil: 'networkidle0' });

		const placeData = await page.evaluate(() => {
			const name = document.querySelector('h1')?.innerText?? 'No Value';
			const website =
				document.querySelector('a[data-item-id="authority"]')?.href ??
				'No Value';
			const phone = document
				.querySelector('[data-tooltip="Copy phone number"]')?.getAttribute('aria-label')?.replace('Phone:', '') ?? 'No value';
			const address = document
				.querySelector('[data-item-id="address"]')?.getAttribute('aria-label') ?? 'No Value';
			const category = document.querySelector('[jsaction="pane.rating.category"]')?.innerText ?? 'No value';

			return { name, website, phone, address, category };
		});

		console.log(placeData.category);

		if ( ! placeData.category.toLowerCase().includes(query) ) {
			console.log("**Not a "+ query +". -"+ placeData.category +"- Skip**");
			continue;
		}

        console.log('****************');
        console.log(placeData.website?? 'No Website');
        console.log('****************');

		console.log( "A "+ query +"! getting data..." );

		let emails;

		if (placeData.website !== 'No Value' && placeData.category.toLowerCase().includes(query)) {
			let contactLinks = [];
			try {
				contactLinks = await getContactLinks(placeData.website);
			} catch (error) {
				console.error('Error in getContactLinks:', error);
			}

			try {
				for (const link of contactLinks) {
					console.log('Searching email in ', link);
					const data = await searchEmails(link);
					if (Array.isArray(data) && data.length > 0) {
						emails = data.filter((n) => n).join(', ') || 'No Value';
						break;
					}
				}
			} catch (error) {
				console.error('Error in processing contactLinks:', error);
				await writeToFile(path.join(__dirname, 'error.log'), `${error.toString()} --- ${link} | getPlacesData 2()\n`);
			}
			
		}

		console.log(
			placeID,
			placeData.name,
			placeData.website,
			placeData.phone,
			placeData.address,
			link,
			emails
		);

		const placeOutput = [
			`"${placeID}"`,
			`"${placeData.name}"`,
			`"${placeData.website}"`,
			`"${placeData.phone}"`,
			`"${placeData.address}"`,
			`"${link}"`
		].join(',');

		fs.appendFile(CONFIG.outputFilename, placeOutput + ',' + emails + '\n', (err) => {
			if (err) {
				console.error('Error writing to file:', err);
			} else {
				console.log(`Successfully wrote data for ${placeData.name} to file.`);
			}
		});

			
		} catch (error) {
			console.error('Error:', error.message);
			await writeToFile(path.join(__dirname, 'error.log'), `${error.toString()} --- ${link} | getPlacesData()\n`);
			return null;
		} finally {
			if (browser) {
				await browser.close();
				if (fs.statSync(chromeTmpDataDir).isDirectory()) {
					// If so, try to delete the folder recursively
					fs.rm(chromeTmpDataDir, { recursive: true, force: true }, (err) => {
					  if (err) {
						console.error('Error deleting folder:', chromeTmpDataDir, err);
					  } else {
						console.log('Successfully deleted folder:', chromeTmpDataDir);
					  }
					});
				  }
			}
		}
	}
}

async function startProcess() {
	try {
		// Load processed zip codes
		await loadprocessedZips();

		// Read the output file and populate the processedPlaces set
		if (fs.existsSync(CONFIG.outputFilename)) {
			const outputContent = await fs.promises.readFile(CONFIG.outputFilename, 'utf8');
			const outputRows = outputContent.split('\n');
			for (let i = 1; i < outputRows.length; i++) {
				const row = outputRows[i].split(',');
				const placeID = row[0].replace(/"/g, '');  // Remove quotes around the ID
				processedPlaces.add(placeID);
			}
		}

		const fileContent = await fs.promises.readFile(CONFIG.inputFilename, 'utf8');
		const rows = fileContent.split('\n');

		for (let i = 0; i < rows.length; i++) {
			try {
				const row = rows[i].split(',');
				const zip = row[0].trim();
				const city = row[1].trim();
				const state = row[2].trim();

				// If the zip has been processed before, skip it
				if (processedZips.has(zip) ) {
					console.log( 'Zipcode done. Skipping..');
					continue;
				}

				if (row.length === 0 ) {
					continue;
				}

				const queryText = zip + ',' + city + ',' + state;
				// const searchUrl =
				// 	CONFIG.mapUrl +
				// 	queryText.replace(' ', '+') +
				// 	'+in+' + city +
				// 	',' + state;

				const searchUrl =
					CONFIG.mapUrl +
					zip + ',' + city +
					',' + state;
					
				console.log(searchUrl);

				await openPuppeteer(searchUrl, queryText);

				// Add the zip to the set of processed zips
				processedZips.add(zip);
				// Append the zip to the processedZipsFile
				fs.appendFile(CONFIG.processedZipsFile, zip + '\n', (err) => {
					if (err) {
						console.error('Error writing to file:', err);
					}
				});
			} catch (error) {
				console.error('Error reading row:', error);
			}
		}
	} catch (error) {
		console.error('Error reading or writing file:', error);
	}
}

startProcess();