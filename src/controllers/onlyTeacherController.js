import { classes } from "../services/classes.js";


const fetchClass = async (req, res, next) => {
    try {
        const data = await classes();
        // console.log(data)
        res.json(data);
    } catch (error) {
        next(error)
    }
}


export {
    fetchClass
}
