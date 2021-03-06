"use strict";
const { path: appRootPath } = require("app-root-path");
require("dotenv").config({ path: require("path").join(appRootPath, ".env") });
const request = require("request");
const program = require("commander");
const pg = require("./lib/pg");
const Table = require("cli-table");
const path = require("path");
const fs = require("fs");

const exitWithMessage = msg => {
    console.log(msg);
    process.exit();
};

const searchPG = (() => {
    const searchQuery = `
    select
        details,
        ts_rank(search, ts.query)::numeric(10,3) as relevance
    from
        (select  
            websearch_to_tsquery('english',$1) ||
            websearch_to_tsquery('simple',$1) ||
            websearch_to_tsquery('simple', replace($1, ' ', ' or ')) query
        ) as ts,
        book 
    where book.search @@ ts.query
    order by relevance desc limit 10;`;
    return async searchPhrase => {
        const res = await pg.query(searchQuery, [searchPhrase]);
        const hits = res.rows.map(row => row.details);
        return hits;
    };
})();

const searchES = searchPhrase =>
    new Promise((resolve, reject) => {
        const { ESHOST, ESPORT } = process.env;
        const path = "_search";
        const options = {
            url: `http://${ESHOST}:${ESPORT}/${path.replace(/^\/*/, "")}`,
            json: true,
            qs: { q: searchPhrase }
        };
        request(options, (err, res, body) => {
            if (err) return reject(err);
            const hits = body.hits.hits.map(h => ({ ...h._source }));
            resolve(hits);
        });
    });

const search = async (db, searchPhrase) => {
    const start = Date.now();
    let hits;
    if (db === "pg") hits = await searchPG(searchPhrase);
    else if (db === "es") hits = await searchES(searchPhrase);
    else throw new Error(`Invalid db option ${db}, select either pg or es`);
    const stop = Date.now();
    return {
        db,
        hits,
        timeTaken: stop - start
    };
};

const fmtSearchResults = hits => {
    const truncate = h => ({
        id: h.id,
        title: `${h.title.slice(0, 50).replace(/[;\r\n]+/g, ";")}${
            h.title.length > 50 ? "..." : ""
        }`,
        authors: `${h.authors.map(a => a.split(",")[0]).slice(0, 3)}`
    });
    const truncatedHits = hits.map(truncate);

    const hitsTable = new Table({
        head: ["id", "title", "authors"],
        colWidths: [7, 55, 15]
    });
    truncatedHits.forEach(h => hitsTable.push([h.id, h.title, h.authors]));

    return hitsTable.toString();
};

const searchPhrasesFromFile = filePath => {
    try {
        const content = fs.readFileSync(filePath, "utf8");
        return content.split("\n");
    } catch (err) {
        exitWithMessage(err.message);
    }
};

const searchPerformanceComparison = async (searchPhrases = [], retakes = 0) => {
    const perfs = searchPhrases.map(phrase => ({
        phrase,
        esTimings: [],
        pgTimings: []
    }));

    do {
        for (let entry of perfs) {
            const res = await Promise.all(
                ["es", "pg"].map(db => search(db, entry.phrase))
            );
            entry.esTimings.push(res[0].timeTaken);
            entry.pgTimings.push(res[1].timeTaken);
        }
    } while (retakes-- > 0);

    const arrSum = arr => arr.reduce((a, b) => a + b, 0);
    const stats = (arr = []) => ({
        max: Math.max(...arr),
        min: Math.min(...arr),
        ave: arrSum(arr) / arr.length
    });

    const perfsWithStats = perfs.map(p => ({
        phrase: p.phrase,
        es: { timings: p.esTimings, ...stats(p.esTimings.slice(1)) },
        pg: { timings: p.pgTimings, ...stats(p.pgTimings.slice(1)) }
    }));
    const sumOfAveragesES = arrSum(perfsWithStats.map(p => p.es.ave));
    const sumOfAveragesPG = arrSum(perfsWithStats.map(p => p.pg.ave));

    return { perfs: perfsWithStats, sumOfAveragesES, sumOfAveragesPG };
};

const fmtSearchPerfComparison = perfs => {
    const perfsTable = new Table({
        head: ["phrase", "(ESmin, PGmin)", "(ESmax, PGmax)", "esAve", "pgAve"],
        colWidths: [20, 20, 20, 15, 15]
    });

    perfs.forEach(p =>
        perfsTable.push([
            p.phrase,
            `(${p.es.min}, ${p.pg.min})`,
            `(${p.es.max}, ${p.pg.max})`,
            p.es.ave.toFixed(2),
            p.pg.ave.toFixed(2)
        ])
    );

    return perfsTable.toString();
};

//CMD ARGS
program
    .version("0.0.1")
    .description(
        "search tool for project gutenberg book details using elasticsearch"
    )
    .usage("[options] <command> [...]")
    .option("-d, --db [database]", "set db for search, either pg or es")
    .option(
        "-f, --file [filepath]",
        "provide path to text file from which a list of search phrases is read from"
    )
    .option("-j, --json", "output seach results as json array")
    .option(
        "-r, --retakes [retake_num]",
        "number of times to repeat searches for performance comparison, minimum 1",
        5
    );

//SEARCH
program
    .command("query [queries...]")
    .alias("q")
    .description("perform search query")
    .action(async (queries = []) => {
        if (!program.db)
            exitWithMessage(
                `error: option '-d, --db [database]' must be specified for this command.`
            );
        if (["pg", "es"].includes(program.db) === false)
            exitWithMessage(
                `error: option '-d, --db [database]' must be either of [pg, es]`
            );

        const res = await search(program.db, queries.join(" "));
        if (program.json) console.log(JSON.stringify(res));
        else {
            const fmtdHits = fmtSearchResults(res.hits);
            console.log(`DB: ${res.db}`);
            console.log(fmtdHits);
            console.log(`Time Taken: ${res.timeTaken} ms`);
        }
    });

//SEARCH
program
    .command("get_book [id]")
    .alias("q")
    .description("perform search query")
    .action(async bookID => {
        if (!bookID) exitWithMessage("provide book ID");
        try {
            const book = (
                await pg.query("select details from book where book_id = $1", [
                    bookID
                ])
            ).rows[0];
            if (!book)
                exitWithMessage(`Book with ID "${bookID}" does not exist`);
            else console.log(book.details);
        } catch (err) {
            console.error(err.message);
        }
    });

//PERFORMANCE COMPARISON
program
    .command("compare_perf")
    .alias("c")
    .description("perform search query")
    .action(async () => {
        const filePath =
            program.file || path.join(path.dirname(__filename), "phrases.txt");
        const searchPhrases = searchPhrasesFromFile(filePath);
        const retakes = Number(program.retakes);
        if (retakes < 1) exitWithMessage(`retakes minimum is 1`);
        const res = await searchPerformanceComparison(searchPhrases, retakes);
        const fmtdPerfs = fmtSearchPerfComparison(res.perfs);
        console.log(fmtdPerfs);
        console.log(`ES ave total: ${res.sumOfAveragesES}`);
        console.log(`PG ave total: ${res.sumOfAveragesPG}`);
    });

const main = async () => {
    await program.parseAsync(process.argv);
};

main().catch(err => console.error(err));
