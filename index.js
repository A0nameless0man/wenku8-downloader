#!/usr/bin/env node
const Novel = require("./lib/downloader.js");

const { program } = require("commander");
const log4js = require("log4js");

const logger = log4js.getLogger();
logger.level = "debug";

function commaSeparatedList(value) {
    return value.split(',');
}

program
    .version("1.0.0")
    .description("wenku8 novel downloader")
    .option("-u, --url <type>", "website url of the novel you want to download")
    .option("-i, --id <int>", "website id of the novel you want to download", commaSeparatedList);
program.parse(process.argv);
logger.warn("开始下载")
if (program.url) {
    Novel.download(program.url);
} else if (program.id) {
    let s = new Set(program.id)
    const p = Promise.all(Array.from(s.keys()).map(
        element => {
            const url = `https://www.wenku8.net/book/${element}.htm`
            return Novel.download(url)
        }
    ))
    p.then(() => {
        logger.info("下载完毕")
        Novel.clean()
    })
} else {
    logger.warn("请使用-u标志输入URL");
}
