#!/usr/bin/env node

//
// See also;
// - https://michaljanaszek.com/blog/test-website-performance-with-puppeteer
// - https://github.com/sitespeedio/chrome-har
// - https://github.com/GoogleChrome/lighthouse/blob/HEAD/docs/readme.md#using-programmatically
// - https://github.com/GoogleChrome/lighthouse/issues/4634
// - https://chromedevtools.github.io/devtools-protocol/tot/Performance
//

const PPT = require('puppeteer');
const PDD = require('puppeteer/DeviceDescriptors');
const PuppeteerHar = require('puppeteer-har');
const commander = require('commander');
const fs = require('fs');

let connect = async (opt) => {
    if (opt.endpoint) {
        return await PPT.connect({
            browserWSEndpoint: opt.endpoint,
        });
    }
    else {
        return await PPT.launch({
            headless: opt.headless,
            args: [
                ...opt.chrome,
                '--no-sandbox', '--disable-gpu', '--ignore-certificate-errors',
                '--no-first-run', '--no-default-browser-check'
            ],
        });
    }
};

let main = async (opt) => {
    let url = opt.args.shift();
    let target = opt.args.map(expr => new RegExp(expr));

    const ua = await connect(opt);
    const page = await ua.newPage();

    if (opt.model) {
        await page.emulate(PDD[opt.model]);
    }

    await page.setExtraHTTPHeaders(opt.header);

    // warmup
    await page.setCacheEnabled(false);
    for (let i = 0; i < opt.warmup; i++) {
        await page.goto(url, {
            waitUntil: 'networkidle2',
    	    timeout: 0,
        });
    }

    if (opt.trace) {
        await page.tracing.start({ path: opt.trace });
    }

    // inject delay
    await page.setRequestInterception(true);
    page.on('request', request => {
        let url = request.url();
        let ret = target.map(re => re.test(url));

        if (opt.verbose) {
            console.log(`URL: ${url}`);
        }

        if (ret.includes(true)) {
            if (opt.verbose) {
                console.log(`Delaying URL: ${url}`);
            }
            setTimeout(() => request.continue(), opt.delay);
        }
        else {
            request.continue();
        }
    });

    const har = new PuppeteerHar(page);
    await har.start();

    await page.goto(url, {
        waitUntil: 'networkidle2',
	    timeout: 0,
    });

    if (opt.screenshot) {
        await page.screenshot({ path: opt.screenshot });
    }

    // save HAR data with additional metrics
    // TODO: Better to integrate lighthouse, if possible
    const data = await har.stop();
    const perf1 = await page._client.send('Performance.getMetrics');
    const perf2 = JSON.parse(await page.evaluate(() => JSON.stringify(window.performance.timing)));
    data['log']['pages'][0]['extra'] = [perf1, perf2];

    if (opt.trace) {
        await page.tracing.stop();
    }

    if (opt.outfile) {
        fs.writeFileSync(opt.outfile, JSON.stringify(data));
    }

    if (! opt.endpoint) {
        await ua.close();
    }
};

let header_add = (header, memo) => {
    let i = header.indexOf(':');
    let key = header.substr(0, i);
    let val = header.substr(i + 1);
    memo[key] = val;
    return memo;
};

let collect = (val, memo) => {
    memo.push(val);
    return memo;
};

commander
    .version('0.0.3')
    .option('-v, --verbose', 'Verbose message output')
    .option('-m, --model <help|model>', 'Emulate device (ex: iPhone 6)')
    .option('-o, --outfile <har>', 'HAR file to save', 'result.har')
    .option('-s, --screenshot <image>', 'Save screenshot')
    .option('-d, --delay <ms>', 'Delay to apply', parseInt, 10000)
    .option('-h, --headless', 'Run headless')
    .option('-e, --endpoint <url>', 'Connect to given websocket endpoint')
    .option('-t, --trace <tracelog>', 'Capture trace log')
    .option('-n, --warmup <N>', 'Fetch page N-times before measurement', parseInt, 0)
    .option('-H, --header <header>', 'Add header', header_add, {})
    .option('-C, --chrome <arg>', 'Pass arg to Chrome', collect, [])
    .parse(process.argv);

if (commander.model == 'help') {
    console.log('# supported models');
    for (let k in PDD) {
        if (k >= 0) continue;
        console.log(k);
    }
    process.exit(0);
}

main(commander);
