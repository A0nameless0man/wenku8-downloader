const Promise = require("bluebird");
const axios = require("axios");
const cheerio = require("cheerio");
const iconv = require("iconv-lite");
const fs = Promise.promisifyAll(require("fs"));
const Url = require("url");
const qs = require("querystring");
const path = require("path");

// 调度器，控制发请求的频率
class Scheduler {
    constructor(count) {
        this.count = count;
        this.queue = [];
        this.run = [];
        this.wait = 1000;
    }

    add(task) {
        this.queue.push(task);
        return this.schedule();
    }
    err() {
        this.wait *= 2;
    }
    succ() {
        this.wait *= 0.9;
    }
    schedule() {
        if (this.run.length < this.count && this.queue.length) {
            const task = this.queue.shift();
            const promise = task().then(() => {
                setTimeout(() => {
                    this.run.splice(this.run.indexOf(promise), 1);
                }, this.wait);
            });
            this.run.push(promise);
            return promise;
        } else {
            return Promise.race(this.run).then(() => this.schedule());
        }
    }
}

let scheduler = new Scheduler(10);

class Novel {
    constructor(obj) {
        console.log("start download", obj.name);
        Object.assign(this, obj);
    }

    static isNotFound(err) {
        return err instanceof Error && err.message.indexOf("404") !== -1
    }

    static async get(url) {
        let res = await axios.get(url, {
            responseType: "arraybuffer",
        });
        let $ = cheerio.load(iconv.decode(res.data, "gbk"));
        return $;
    }

    static async scheduleGet(url) {
        return new Promise((resolve, reject) => {
            scheduler.add(async () => {
                try {
                    const res = await this.get(url);
                    scheduler.succ()
                    resolve(res);
                } catch (err) {
                    if (!this.isNotFound(err)) {
                        scheduler.err()
                    }
                    reject(err);
                }
            })
        })
    }
    static async scheduleMustGet(url) {
        let retryLimit = 5
        let error = null
        while (retryLimit) {
            try {
                const res = await this.scheduleGet(url);
                return res
            } catch (err) {
                console.error(`failed to download ${url} because ${err.message} , retryLimit:${retryLimit}`);
                error = err;
                if (this.isNotFound(err)) {
                    break;
                }
                retryLimit = retryLimit - 1;
            }
        }
        throw error;
    }
    static async rawGet(url) {
        return (await axios.get(url, { responseType: "arraybuffer" })).data;
    }

    static async scheduleRawGet(url) {
        return new Promise((resolve, reject) => {
            scheduler.add(async () => {
                try {
                    const res = await this.rawGet(url);
                    scheduler.succ()
                    resolve(res);
                } catch (err) {
                    if (!this.isNotFound(err)) {
                        scheduler.err()
                    }
                    reject(err);
                }
            })
        })
    }


    static async scheduleMustRawGet(url) {
        let retryLimit = 5
        let error = null
        while (retryLimit) {
            try {
                const res = await this.scheduleRawGet(url);
                return res
            } catch (err) {
                console.error(`failed to bin download ${url} because ${err.message} , retryLimit:${retryLimit}`);
                error = err;
                if (this.isNotFound(err)) {
                    break;
                }
                retryLimit = retryLimit - 1;

            }
        }
        throw error;
    }

    static purifyContent(s) {
        return s.
            replace("&nbsp;", "").
            replace("更多精彩热门日本轻小说、动漫小说，轻小说文库(http://www.wenku8.com) 为你一网打尽！", "").
            replace("本文来自 轻小说文库(http://www.wenku8.com)", "").
            replace("台版 转自 轻之国度", "").
            replace(
                "最新最全的日本动漫轻小说 轻小说文库(http://www.wenku8.com) 为你一网打尽！",
                ""
            ).replace("★☆★☆★☆轻小说文库(Www.WenKu8.com)☆★☆★☆★", "");
    }

    static async getChapter(url) {
        let $$ = await this.scheduleMustGet(url);
        if ($$('#contentmain span').first().text().trim() == 'null') {
            let content = ""
            let images = []
            let v = url.substring(0, url.lastIndexOf(".")).split("/")
            try {
                let resp = await this.scheduleMustRawGet(`http://dl.wenku8.com/pack.php?aid=${v.slice(-2)[0]}&vid=${v.slice(-1)[0]}`)
                let html = cheerio.load(iconv.decode(resp, "utf-8"))
                content = html.text()
                images = html("img").map(function (i, imgEle) {
                    let imgsrc = imgEle.attribs.src
                    return imgsrc
                }).get();
            } catch (e) {
                if (this.isNotFound(e)) {
                    let resp = await this.scheduleMustRawGet(`http://dl.wenku8.com/packtxt.php?aid=${v.slice(-2)[0]}&vid=${v.slice(-1)[0]}&charset=utf-8`)
                    content = iconv.decode(resp, "UTF-16LE")
                } else {
                    throw e
                }
            }
            content = this.purifyContent(content)
            // let picReg = /http:\/\/pic\.wenku8\.com\/pictures\/[\/0-9]+.jpg/g
            // let picRegL = /http:\/\/pic\.wenku8\.com\/pictures\/[\/0-9]+.jpg\([0-9]+K\)/g
            // let images = content.match(picReg) ?? []
            // content = content.replace(picRegL, "")
            return { content, images }
        } else {
            let content = $$("#content")
                .text()
            content = this.purifyContent(content)
            let images = $$("img").map(function (i, imgEle) {
                let imgsrc = imgEle.attribs.src
                return imgsrc
            }).get();
            return { content, images };
        }
    }

    static async mkdirSingleNovel(id, name) {
        try {
            await fs.stateAsync(path.join(process.cwd(), `./novels/${id}-${name}`));
            // await fs.statAsync(`./novels/${id}-${name}`)
        } catch (e) {
            await fs.mkdirAsync(path.join(process.cwd(), `./novels/${id}-${name}`), { recursive: true });
            // await fs.mkdirAsync(`./novels/${id}-${name}`)
        }
    }
    /**
     *
     *
     * @static
     * @param {*} url
     * @memberof Novel
     */
    static async download(url) {
        if (!fs.existsSync(path.join(process.cwd(), "novels"))) {
            fs.mkdirSync(path.join(process.cwd(), "novels"));
        }

        let $ = await this.scheduleMustGet(url); // 获取某小说的主页

        let id; // 小说的完整编号
        let backUrl = url.substring(url.lastIndexOf("/") + 1, url.lastIndexOf(".")); // 小说的编号
        id =
            backUrl === "articleinfo"
                ? `1-${qs.parse(Url.parse(url).query).id}`
                : `2-${backUrl}`;

        const novel = new Novel({
            id,
            name: $("b").eq(2).text(),
            desc: $(".hottext:nth-of-type(4)").nextAll("span").text(),
            indexUrl: url,
            catalogUrl: $("#content")
                .children()
                .first()
                .children()
                .eq(5)
                .children()
                .children()
                .first()
                .find("a")
                .attr("href"),
        });
        Novel.mkdirSingleNovel(novel.id, novel.name); // 创建本地目录

        if (novel.catalogUrl !== undefined) {
            let catalogBaseUrl = novel.catalogUrl.substring(
                0,
                novel.catalogUrl.lastIndexOf("/")
            );
            $ = await this.scheduleMustGet(novel.catalogUrl); // 获取某小说的章节目录页
            console.log("chapter loaded for novel", novel.name)
            for (let [index, item] of Object.entries($("table td a"))) {
                index = parseInt(index);
                let href = $(item).attr("href");
                if (href) {
                    let url = `${catalogBaseUrl}/${href}`; // 该小说的某章节的路径
                    let title = $(item).text();
                    let { content, images } = (await this.getChapter(url));
                    if (images) {
                        images = await Promise.all(images.map(async (image) => {
                            let imgname = image.split("/").slice(-1)[0];
                            let resp = await this.scheduleMustRawGet(image);
                            await fs.writeFileAsync(
                                path.join(
                                    process.cwd(),
                                    `./novels/${novel.id}-${novel.name}/${imgname}`
                                ),
                                resp
                            );
                            console.log(
                                `${novel.name}[id=${novel.id}]第${index + 1}章节图片${imgname}已下载完成`
                            );
                            return imgname
                        }))
                        images = images.map((v) => `![](${v})`)
                        content += images.join('\n')
                    }
                    await fs.writeFileAsync(
                        path.join(
                            process.cwd(),
                            `./novels/${novel.id}-${novel.name}/${index + 1}.md`
                        ),
                        `# ${title}\n` + content
                    );
                    console.log(
                        `${novel.name}[id=${novel.id}]第${index + 1}章节已下载完成`
                    );

                }
            }
        }
    }
}

// 你可以把下面的地址换成你想要下载的小说的目录页
module.exports = Novel;
