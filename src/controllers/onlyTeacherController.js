import { classes } from "../services/classes.js";
import { subjects } from "../services/subject.js";


const fetchClass = async (req, res, next) => {
    try {
        const data = await classes();
        // console.log(data)
        res.json(data);
    } catch (error) {
        console.log(error)
        next(error)
    }
}

const fetchSubject = async (req, res, next) => {
    try {
        const data = await subjects();
        res.json(data);
    } catch (error) {
        console.log(error)
        next(error)
    }
}


export {
    fetchClass,
    fetchSubject
}
