-- Fake "live" MySQL database for rehearsing the MySQL -> Postgres data move.
-- Mimics the live schema: no is_deleted / payslip-snapshot columns, TINYINT
-- booleans, Term.active as BIT(1) with a NULL, a 0000-00-00 date, plaintext
-- passwords, a student whose class no longer exists (orphan), a duplicate
-- Student_marks row, an extra legacy column and an extra legacy table.
-- Used by scripts/rehearse-data-move.sh. Contains NO real school data.
DROP DATABASE IF EXISTS dbo;
CREATE DATABASE dbo;
USE dbo;
SET sql_mode='';
CREATE TABLE `Allowance` (
  `allowance_id` INT NOT NULL AUTO_INCREMENT,
  `salaryId` INT,
  `title` VARCHAR(255),
  `amount` DECIMAL(18,2),
  PRIMARY KEY (`allowance_id`)
);
CREATE TABLE `Assignment` (
  `assignment_id` INT NOT NULL AUTO_INCREMENT,
  `fileData` VARCHAR(255),
  `class` VARCHAR(255),
  `subject` VARCHAR(255),
  `submission_date` VARCHAR(255),
  `teacher_id` INT,
  `file_name` VARCHAR(255),
  PRIMARY KEY (`assignment_id`)
);
CREATE TABLE `Attendance` (
  `attendance_id` INT NOT NULL AUTO_INCREMENT,
  `class` VARCHAR(255),
  `student_id` INT,
  `term_id` INT,
  `status` CHAR(20),
  `date_marked` DATE,
  `date_end` DATE,
  PRIMARY KEY (`attendance_id`)
);
CREATE TABLE `Bus_fee` (
  `bus_fee_id` INT NOT NULL AUTO_INCREMENT,
  `teacher` VARCHAR(255),
  `class` VARCHAR(255),
  `amount` DECIMAL(18,2),
  `date` DATE,
  PRIMARY KEY (`bus_fee_id`)
);
CREATE TABLE `Class` (
  `class_id` INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(255),
  `section` VARCHAR(255),
  `teacher_id` INT,
  `capacity` INT,
  `tuition` INT,
  `firstAid` INT,
  `PTA` INT,
  `water` INT,
  `maintenance` INT,
  `stationary` INT,
  `cocurricular` INT,
  `fees` INT,
  PRIMARY KEY (`class_id`)
);
CREATE TABLE `ClassFee` (
  `class_fee_id` INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(255),
  `class_id` INT,
  `amount` INT,
  PRIMARY KEY (`class_fee_id`)
);
CREATE TABLE `StudentFee` (
  `student_fee_id` INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(255),
  `student_id` INT,
  `amount` INT,
  PRIMARY KEY (`student_fee_id`)
);
CREATE TABLE `Employee_salary` (
  `employee_salary_id` INT NOT NULL AUTO_INCREMENT,
  `teacherId` INT,
  `salaryId` INT,
  PRIMARY KEY (`employee_salary_id`)
);
CREATE TABLE `Event` (
  `event_id` INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(255),
  `description` TEXT,
  `date` DATE,
  `time` VARCHAR(255),
  `created_at` VARCHAR(255),
  PRIMARY KEY (`event_id`)
);
CREATE TABLE `AccountCategory` (
  `account_category_id` INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(255),
  `type` VARCHAR(255),
  PRIMARY KEY (`account_category_id`)
);
CREATE TABLE `Income` (
  `income_id` INT NOT NULL AUTO_INCREMENT,
  `income` VARCHAR(255),
  `amount` DECIMAL(18,2),
  `account_category_id` INT,
  `date` DATE,
  PRIMARY KEY (`income_id`)
);
CREATE TABLE `Expense` (
  `expense_id` INT NOT NULL AUTO_INCREMENT,
  `expense` VARCHAR(255),
  `amount` DECIMAL(18,2),
  `account_category_id` INT,
  `date` DATE,
  PRIMARY KEY (`expense_id`)
);
CREATE TABLE `Extra_classes` (
  `extra_classes_id` INT NOT NULL AUTO_INCREMENT,
  `teacher` VARCHAR(255),
  `class` VARCHAR(255),
  `amount` DECIMAL(18,2),
  `date` DATE,
  PRIMARY KEY (`extra_classes_id`)
);
CREATE TABLE `Fee` (
  `fee_id` INT NOT NULL AUTO_INCREMENT,
  `student_id` INT,
  `class_id` INT,
  `total` DECIMAL(18,2),
  `paid` DECIMAL(18,2),
  `remaining` DECIMAL(18,2),
  `payment_mode` VARCHAR(255),
  `amount_in_words` VARCHAR(255),
  `term` VARCHAR(255),
  `date_paid` DATE,
  PRIMARY KEY (`fee_id`)
);
CREATE TABLE `FeeCheck` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `value` TINYINT(1),
  PRIMARY KEY (`id`)
);
CREATE TABLE `Feeding_fee` (
  `feeding_fee_id` INT NOT NULL AUTO_INCREMENT,
  `teacher` VARCHAR(255),
  `class` VARCHAR(255),
  `amount` DECIMAL(18,2),
  `date` DATE,
  PRIMARY KEY (`feeding_fee_id`)
);
CREATE TABLE `KG_assessment` (
  `kg_assessment_id` INT NOT NULL AUTO_INCREMENT,
  `assessment` VARCHAR(255),
  `category` VARCHAR(255),
  `satisfactory` INT,
  `improved` INT,
  `needs_improvement` INT,
  `unsatisfactory` INT,
  `not_applicable` INT,
  `term` VARCHAR(255),
  `class` VARCHAR(255),
  `date` DATE,
  `student_id` INT,
  `class_score` INT,
  `exam_score` INT,
  `class_score_percentage` INT,
  `exam_score_percentage` INT,
  `total_score` INT,
  `term_id` INT,
  `promoted` VARCHAR(255),
  PRIMARY KEY (`kg_assessment_id`)
);
CREATE TABLE `Notification` (
  `notification_id` INT NOT NULL AUTO_INCREMENT,
  `notification` TEXT,
  `class` VARCHAR(255),
  `date` DATETIME,
  `studentId` INT,
  PRIMARY KEY (`notification_id`)
);
CREATE TABLE `Parent` (
  `parent_id` INT NOT NULL AUTO_INCREMENT,
  `f_name` VARCHAR(255),
  `l_name` VARCHAR(255),
  `gender` VARCHAR(255),
  `contact` VARCHAR(255),
  `contact1` VARCHAR(255),
  `relationship` VARCHAR(255),
  `email` VARCHAR(255),
  `occupation` VARCHAR(255),
  PRIMARY KEY (`parent_id`)
);
CREATE TABLE `Salary` (
  `salary_id` INT NOT NULL AUTO_INCREMENT,
  `title` VARCHAR(255),
  `rank` VARCHAR(255),
  `amount` DECIMAL(18,2),
  PRIMARY KEY (`salary_id`)
);
CREATE TABLE `Salary_payment` (
  `salary_payment_id` INT NOT NULL AUTO_INCREMENT,
  `teacher_id` INT,
  `amount` VARCHAR(255),
  `salary_id` INT,
  `salary_date` VARCHAR(255),
  `payment_method` VARCHAR(255),
  `amount_in_words` TEXT,
  `date_paid` DATE,
  `term` INT,
  PRIMARY KEY (`salary_payment_id`)
);
CREATE TABLE `Student` (
  `student_id` INT NOT NULL AUTO_INCREMENT,
  `password` VARCHAR(255),
  `f_name` VARCHAR(255),
  `m_name` VARCHAR(255),
  `l_name` VARCHAR(255),
  `dob` DATE,
  `age` INT,
  `gender` VARCHAR(255),
  `address` VARCHAR(255),
  `class` VARCHAR(255),
  `date_registered` DATE,
  `date_updated` DATE,
  `parent_id` INT,
  `class_id` INT,
  `fees_paid` INT,
  `fees_owing` INT,
  `legacy_note` VARCHAR(50),
  PRIMARY KEY (`student_id`)
);
CREATE TABLE `Student_marks` (
  `student_marks_id` INT NOT NULL AUTO_INCREMENT,
  `subject_id` INT,
  `student_id` INT,
  `exam_score` DECIMAL(18,2),
  `exam_score_percentage` DECIMAL(18,2),
  `class_score` DECIMAL(18,2),
  `class_score_percentage` DECIMAL(18,2),
  `total_score` DECIMAL(18,2),
  `class` VARCHAR(255),
  `remarks` VARCHAR(255),
  `term` VARCHAR(255),
  `term_id` INT,
  `date` DATE,
  PRIMARY KEY (`student_marks_id`)
);
CREATE TABLE `Student_result` (
  `student_result_id` INT NOT NULL AUTO_INCREMENT,
  `student_id` INT,
  `raw_score` DECIMAL(18,2),
  `pass_raw_score` INT,
  `total_raw_score` INT,
  `class_total` INT,
  `result_status` VARCHAR(255),
  `promoted_to` VARCHAR(255),
  `class` VARCHAR(255),
  `term` VARCHAR(255),
  `term_id` INT,
  `conduct` TEXT,
  `attitude` TEXT,
  `interest` TEXT,
  `teacher_remarks` TEXT,
  `date` DATE,
  PRIMARY KEY (`student_result_id`)
);
CREATE TABLE `Subject` (
  `subject_id` INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(255),
  `exam_total_marks` DECIMAL(18,2),
  `class_total_marks` DECIMAL(18,2),
  `exam_percentage` DECIMAL(18,2),
  `class_percentage` DECIMAL(18,2),
  `pass_marks` DECIMAL(18,2),
  PRIMARY KEY (`subject_id`)
);
CREATE TABLE `Teacher` (
  `teacher_id` INT NOT NULL AUTO_INCREMENT,
  `f_name` VARCHAR(255),
  `l_name` VARCHAR(255),
  `password` VARCHAR(255),
  `gender` VARCHAR(255),
  `phone` VARCHAR(255),
  `email` VARCHAR(255),
  `address` VARCHAR(255),
  `class_id` INT,
  `category` VARCHAR(255),
  `salary_id` INT,
  `staff_position` VARCHAR(255),
  `ssnit_number` VARCHAR(255),
  `tin_number` VARCHAR(255),
  `bank` VARCHAR(255),
  `account_number` VARCHAR(255),
  `date_updated` DATE,
  `date_registered` DATE,
  PRIMARY KEY (`teacher_id`)
);
CREATE TABLE `Total_attendance` (
  `total_attendance_id` INT NOT NULL AUTO_INCREMENT,
  `student_id` INT,
  `present` INT,
  `sick` INT,
  `attendance` INT,
  `term_id` INT,
  PRIMARY KEY (`total_attendance_id`)
);
CREATE TABLE `User_account` (
  `username` VARCHAR(255) NOT NULL,
  `name` VARCHAR(255),
  `email` VARCHAR(255),
  `category` VARCHAR(255),
  `password` VARCHAR(255),
  `teacherId` INT,
  PRIMARY KEY (`username`)
);
CREATE TABLE `Deductions` (
  `deductions_id` INT NOT NULL AUTO_INCREMENT,
  `salary_id` INT,
  `title` VARCHAR(255),
  `amount` DECIMAL(18,2),
  PRIMARY KEY (`deductions_id`)
);
CREATE TABLE `Term` (
  `term_id` INT NOT NULL AUTO_INCREMENT,
  `term` VARCHAR(255),
  `start_date` DATE,
  `end_date` DATE,
  `auto_close_date` DATE,
  `active` BIT(1),
  PRIMARY KEY (`term_id`)
);
CREATE TABLE `Tax` (
  `tax_id` INT NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(255),
  `amount` DECIMAL(18,2),
  `salary_id` INT,
  PRIMARY KEY (`tax_id`)
);
CREATE TABLE `KgCalcValues` (id INT PRIMARY KEY, v INT);

INSERT INTO Term VALUES (1,'1','2025-09-08','2025-12-12',NULL,b'0'),(2,'2','2026-01-06','2026-04-02',NULL,b'1'),(3,'3','0000-00-00',NULL,NULL,NULL);
INSERT INTO Salary VALUES (1,'Teacher Grade A','A',2500.00);
INSERT INTO Class (class_id,name,section,teacher_id,capacity,tuition) VALUES (1,'JHS 1','JHS',1,40,900),(2,'KG 1','KG',2,30,600);
INSERT INTO Teacher (teacher_id,f_name,l_name,password,gender,phone,class_id,category,salary_id) VALUES (1,'Ama','Mensah','teach123','F','0241112222',1,'Teaching',1),(2,'Kofi','Owusu',NULL,'M','0243334444',2,'Teaching',1);
INSERT INTO Parent VALUES (1,'Yaw','Boateng','M','0245556666',NULL,'Father',NULL,'Trader'),(2,'Efua','Boateng','F','0245556666',NULL,'Mother',NULL,'Nurse');
INSERT INTO Student (student_id,password,f_name,l_name,dob,age,gender,class,parent_id,class_id,fees_paid,fees_owing,legacy_note) VALUES
 (1,'stud123','Kwame','Boateng','2013-05-02',12,'M','JHS 1',1,1,500,400,'x'),
 (2,NULL,'Akua','Boateng','2020-01-15',5,'F','KG 1',2,2,0,600,NULL),
 (3,'pw3','Orphan','Kid','2014-02-02',11,'M','Old Class',1,99,0,0,NULL);
INSERT INTO Subject (subject_id,name,exam_total_marks,class_total_marks,exam_percentage,class_percentage,pass_marks) VALUES (1,'Mathematics',100,100,70,30,40),(2,'English',100,100,70,30,40);
INSERT INTO Student_marks VALUES (1,1,1,80,56,90,27,83,'JHS 1','Excellent','2',2,'2026-02-01'),(2,2,1,60,42,70,21,63,'JHS 1','Good','2',2,'2026-02-01'),(3,2,1,61,42.7,70,21,63.7,'JHS 1','Good','2',2,'2026-02-02');
INSERT INTO Attendance VALUES (1,'JHS 1',1,2,'Present','2026-01-07',NULL),(2,'JHS 1',1,2,'Absent','2026-01-08',NULL),
  -- planted: a duplicate register mark (same pupil/day/term), common in live data
  (3,'JHS 1',1,2,'Present','2026-01-07',NULL);
INSERT INTO Fee VALUES (1,1,1,900,500,400,'Cash','Five hundred','2',  '2026-01-10');
-- planted: a payment of a hard-deleted pupil (id 50): the Student sequence must start above 50
INSERT INTO Fee VALUES (2,50,1,900,100,800,'Cash','One hundred','2',  '2026-01-11');
INSERT INTO User_account VALUES ('admin','Head','head@pp.com','Administrator','admin123',NULL),('staff/1','Ama Mensah',NULL,'Class Teacher','$2b$10$abcdefghijklmnopqrstuuJ8sQ0rGkF6Jf2c3yC9m0Yb0Q2y7hP2K',1);
INSERT INTO FeeCheck VALUES (1,1);
INSERT INTO Event VALUES (1,'PTA Meeting','Termly PTA','2026-02-20','10:00','2026-02-01 08:00:00');
INSERT INTO AccountCategory VALUES (1,'Utilities','expense');
INSERT INTO Expense VALUES (1,'ECG bill',350.50,1,'2026-01-20');
INSERT INTO KgCalcValues VALUES (1,1);
