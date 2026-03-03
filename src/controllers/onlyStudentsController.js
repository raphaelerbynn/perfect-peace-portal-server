import { getFeeCheck, getLastFee } from "../services/fee.js";
import { getNurseryResults, getResults, getResultDetails } from "../services/results.js";


const fetchResults = async (req, res, next) => {
    const { id } = req.params.user;

    try {
        const results = await getResults(id);

        const separateArrays = {};
        results.forEach((result) => {
            const key = `${result.term}_${result.class}_${result.year}`;
            if (!separateArrays[key]) {
                separateArrays[key] = [];
            }
            separateArrays[key].push(result);
        });

        // Convert the separate arrays into an array of arrays
        const data = Object.values(separateArrays);

        // console.log(data)
        res.json(data);
    } catch (error) {
        console.log(error)
        next(error)
    }
}

const fetchNurseryResults = async (req, res, next) => {
    const { id } = req.params.user;

    try {
        const results = await getNurseryResults(id);
        // console.log(results)

        const separateArrays = {};
        results.forEach((result) => {
            const key = `${result.term}_${result.class}_${result.formatted_date}`;
            if (!separateArrays[key]) {
                separateArrays[key] = [];
            }
            separateArrays[key].push(result);
        });

        // Convert the separate arrays into an array of arrays
        const data = Object.values(separateArrays);

        res.json(data);
    } catch (error) {
        console.log(error)
        next(error)
    }
}

const fetchResultDetails = async (req, res, next) => {
    const { id } = req.params.user;

    try {
        const data = await getResultDetails(id);
        res.json(data);
    } catch (error) {
        console.log(error)
        next(error)
    }
}

const fetchFeeCheck = async (req, res) => {

    try {
        const data = await getFeeCheck();
        res.json(data);
    } catch (error) {
        console.log(error)
    }
}

const fetchLastPaid = async (req, res, next) => {
    const { id } = req.params.user;

    try {
        const data = await getLastFee(id);
        res.json(data);
    } catch (error) {
        console.log(error)
        next(error);
    }
}

export {
    fetchResults,
    fetchNurseryResults,
    fetchFeeCheck,
    fetchResultDetails,
    fetchLastPaid
}