#!/usr/bin/env node

const PPT = require('puppeteer');
const PDD = require('puppeteer/DeviceDescriptors');
const PuppeteerHar = require('puppeteer-har');
const commander = require('commander');

let main = async (opt) => {
    let url = opt.args.shift();
    let target = opt.args.map(expr => new RegExp(expr))

    const ua = await PPT.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-gpu'],
    });
    const page = await ua.newPage();

    if (opt.model) {
        await page.emulate(PDD[opt.model]);
    }

    // inject delay
    await page.setRequestInterception(true);
    page.on('request', request => {
        let url = request.url()
        let ret = target.map(re => re.test(url))

        if (ret.includes(true)) {
            console.log(`Delaying URL: ${url}`)
            setTimeout(() => request.continue(), opt.delay);
        }
        else {
            request.continue();
        }
    });

    const har = new PuppeteerHar(page);
    await har.start({ path: opt.outfile });

    await page.goto(url, {
        waitUntil: 'networkidle2',
	    timeout: 0,
    });

    if (opt.screenshot) {
        await page.screenshot({ path: opt.screenshot });
    }

    await har.stop();
    await ua.close();
};

commander
    .version('0.0.1')
    .option('-m, --model <model>', 'Emulate device', 'iPhone 6')
    .option('-o, --outfile <har>', 'HAR file to save', 'result.har')
    .option('-s, --screenshot <image>', 'Save screenshot')
    .option('-d, --delay <ms>', 'Delay to apply', parseInt)
    .parse(process.argv)

main(commander);
